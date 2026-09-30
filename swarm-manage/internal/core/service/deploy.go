package service

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
)

// Desplegar una imagen en un servicio que ya existe. Es `deploy-rrhh` (el
// guion de los servidores de RRHH, en el repo `ansible-swarm`) generalizado:
//
//  1. se valida lo que llega —el backend ya lo hizo, pero esta es la máquina—;
//  2. se baja la imagen **antes** de tocar el servicio: si no existe o no hay
//     permiso, falla aquí y el servicio viejo sigue en pie;
//  3. se clava el digest (`repo:tag@sha256:…`), para que un rollback vuelva a
//     los mismos bytes aunque alguien reutilice el tag;
//  4. se cambia la imagen con `service update` y nada más del spec;
//  5. se espera a que Swarm converja, y se comprueba que la imagen que quedó
//     es la pedida: Swarm puede deshacer una actualización él solo y seguir
//     contestando 200, así que «actualizó» no es «desplegó».

// DeployJob es el trabajo que manda el backend (domain.DeployJob allí).
type DeployJob struct {
	DeploymentID string `json:"deploymentId"`
	Stack        string `json:"stack"`
	ServiceName  string `json:"serviceName"`
	ImageRepo    string `json:"imageRepo"`
	Image        string `json:"image"`
}

// FinishReport: cómo acabó (domain.AgentFinishRequest en el backend).
type FinishReport struct {
	Status        string `json:"status"`
	Error         string `json:"error,omitempty"`
	PreviousImage string `json:"previousImage,omitempty"`
	FinalImage    string `json:"finalImage,omitempty"`
}

// DeployDocker: lo que el Deployer necesita de Docker. Una interfaz para
// probarlo sin un socket de verdad.
type DeployDocker interface {
	FindService(ctx context.Context, name string) (*repository.ServiceState, error)
	InspectService(ctx context.Context, id string) (*repository.ServiceState, error)
	PullImage(ctx context.Context, image, registryAuth string) error
	ImageDigest(ctx context.Context, image string) (string, error)
	UpdateServiceImage(ctx context.Context, id string, version int, image, registryAuth string) error
}

// DeployReporter: a quién se le cuenta cómo va.
type DeployReporter interface {
	Log(ctx context.Context, jobID, line string)
	Finish(ctx context.Context, jobID string, r FinishReport) error
}

type Deployer struct {
	Docker DeployDocker
	Report DeployReporter
	// RegistryAuth devuelve la cabecera `X-Registry-Auth` para una imagen, o
	// "" si no hay credenciales (imágenes públicas).
	RegistryAuth func(image string) string
	// Cuánto se espera a que Swarm converja, y cada cuánto se mira.
	Converge, Poll time.Duration
}

func NewDeployer(docker DeployDocker, report DeployReporter, auth func(string) string) *Deployer {
	return &Deployer{Docker: docker, Report: report, RegistryAuth: auth, Converge: 5 * time.Minute, Poll: 2 * time.Second}
}

// refPattern es el mismo que `domain.refPattern` del backend.
var refPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(@sha256:[0-9a-f]{64})?$`)

// Validate: la imagen tiene que ser del repositorio del trabajo, con una
// referencia segura. Nunca una imagen libre.
func (j DeployJob) Validate() error {
	ref, ok := strings.CutPrefix(j.Image, j.ImageRepo+":")
	if j.ImageRepo == "" || !ok || !refPattern.MatchString(ref) {
		return fmt.Errorf("la imagen %q no es del repositorio %q", j.Image, j.ImageRepo)
	}
	if j.ServiceName == "" || j.Stack == "" {
		return fmt.Errorf("el trabajo no dice qué servicio")
	}
	return nil
}

// Run despliega y lo cuenta. Siempre termina con un Finish, salga como salga.
func (d *Deployer) Run(ctx context.Context, jobID string, raw json.RawMessage) {
	log := func(format string, a ...any) { d.Report.Log(ctx, jobID, fmt.Sprintf(format, a...)) }
	fail := func(prev string, err error) {
		log("✗ %v", err)
		_ = d.Report.Finish(ctx, jobID, FinishReport{Status: "failed", Error: err.Error(), PreviousImage: prev})
	}

	var job DeployJob
	if err := json.Unmarshal(raw, &job); err != nil {
		fail("", fmt.Errorf("trabajo ilegible: %w", err))
		return
	}
	if err := job.Validate(); err != nil {
		fail("", err)
		return
	}

	svc, err := d.Docker.FindService(ctx, job.ServiceName)
	if err != nil {
		fail("", err)
		return
	}
	if svc.Stack != job.Stack {
		fail("", fmt.Errorf("el servicio %s es del stack %q, no de %q", svc.Name, svc.Stack, job.Stack))
		return
	}
	prev := svc.Image
	log("servicio %s, ahora con %s", svc.Name, prev)

	auth := ""
	if d.RegistryAuth != nil {
		auth = d.RegistryAuth(job.Image)
	}
	final := job.Image
	if !strings.Contains(job.Image, "@") {
		log("bajando %s", job.Image)
		if err := d.Docker.PullImage(ctx, job.Image, auth); err != nil {
			if auth == "" && strings.Contains(strings.ToLower(err.Error()), "denied") {
				err = fmt.Errorf("%w (este agente no tiene credenciales del registro: guarda el token de GitHub del servidor en cac y reinstala el agente)", err)
			}
			fail(prev, err)
			return
		}
		digest, err := d.Docker.ImageDigest(ctx, job.Image)
		if err != nil {
			fail(prev, err)
			return
		}
		final = job.Image + "@" + strings.SplitN(digest, "@", 2)[1]
	}
	log("actualizando a %s", final)
	if err := d.Docker.UpdateServiceImage(ctx, svc.ID, svc.Version, final, auth); err != nil {
		fail(prev, err)
		return
	}

	if err := d.converge(ctx, svc.ID, final, log); err != nil {
		fail(prev, err)
		return
	}
	log("✓ desplegado")
	_ = d.Report.Finish(ctx, jobID, FinishReport{Status: "succeeded", PreviousImage: prev, FinalImage: final})
}

// converge espera a que Swarm termine la actualización y comprueba que quedó
// la imagen pedida.
func (d *Deployer) converge(ctx context.Context, id, final string, log func(string, ...any)) error {
	deadline := time.Now().Add(d.Converge)
	vueltas := 0
	for {
		st, err := d.Docker.InspectService(ctx, id)
		if err != nil {
			return err
		}
		vueltas++
		switch st.UpdateState {
		case "completed":
			if st.Image != final {
				return fmt.Errorf("Swarm dio la actualización por terminada con otra imagen (%s)", st.Image)
			}
			return nil
		case "paused", "rollback_started", "rollback_paused", "rollback_completed":
			return fmt.Errorf("Swarm deshizo la actualización (%s): %s", st.UpdateState, st.UpdateMessage)
		case "":
			// Sin estado de actualización: el servicio no tenía tareas que
			// cambiar (réplicas a 0). Con la imagen puesta y unas vueltas sin
			// novedad, está.
			if st.Image == final && vueltas >= 3 {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Swarm no terminó la actualización en %s (sigue %q)", d.Converge, st.UpdateState)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.Poll):
		}
	}
}
