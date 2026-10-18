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
//  4. si el servicio tiene comando de migración, corre **antes**, como un job
//     de Swarm con la imagen nueva y lo mismo que el servicio (redes,
//     secrets): si falla, el servicio no se toca;
//  5. se cambia la imagen con `service update` y nada más del spec;
//  6. se espera a que Swarm converja, y se comprueba que la imagen que quedó
//     es la pedida: Swarm puede deshacer una actualización él solo y seguir
//     contestando 200, así que «actualizó» no es «desplegó».

// DeployJob es el trabajo que manda el backend (domain.DeployJob allí).
type DeployJob struct {
	DeploymentID string `json:"deploymentId"`
	Stack        string `json:"stack"`
	ServiceName  string `json:"serviceName"`
	ImageRepo    string `json:"imageRepo"`
	Image        string `json:"image"`
	// MigrateCommand: lo que corre antes del update, con la imagen nueva. Vacío
	// = no hay migraciones.
	MigrateCommand string `json:"migrateCommand,omitempty"`
	// Build: construir Image en este servidor antes de desplegarla (v6). Nil
	// = la imagen ya existe en un registro.
	Build *BuildSpec `json:"build,omitempty"`
}

// BuildSpec: domain.BuildSpec del backend. Nombres de build args, nunca
// valores; el token clona el repo y dura una hora.
type BuildSpec struct {
	Repo       string   `json:"repo"`
	Sha        string   `json:"sha"`
	Dockerfile string   `json:"dockerfile"`
	Context    string   `json:"context"`
	BuildArgs  []string `json:"buildArgs"`
	CloneToken string   `json:"cloneToken"`
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
	CreateMigrationJob(ctx context.Context, fromServiceID, name, image, command, registryAuth string) (string, error)
	JobTask(ctx context.Context, serviceID string) (repository.TaskState, error)
	JobLogs(ctx context.Context, serviceID string, tail int) ([]string, error)
	JobLogsSince(ctx context.Context, serviceID string, since time.Time) ([]repository.LogLine, error)
	RemoveService(ctx context.Context, id string) error
	// Para construir en el servidor (v6).
	NodeCount(ctx context.Context) (int, error)
	HostMemory(ctx context.Context) (int64, error)
	FindServiceSecret(ctx context.Context, service, key string) (id, name string, err error)
	CreateSecret(ctx context.Context, name string, data []byte, labels map[string]string) (string, error)
	RemoveSecret(ctx context.Context, id string) error
	CreateJob(ctx context.Context, spec map[string]any) (string, error)
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
	// Cuánto puede durar una migración.
	Migrate time.Duration
	// Cuánto puede durar un build (el backend da el deploy por perdido a los
	// 45 minutos; esto acaba antes, con su motivo).
	Build time.Duration
	// Cada cuánto pasa al deploy lo nuevo del log del build.
	BuildLogEvery time.Duration
	// MemAvailable: la memoria libre de la máquina; inyectable en las pruebas.
	MemAvailable func() int64
	// SwapFree: la swap libre de la máquina; inyectable en las pruebas.
	SwapFree func() int64
}

func (d *Deployer) swapFree() int64 {
	if d.SwapFree != nil {
		return d.SwapFree()
	}
	return repository.SwapFree()
}

func (d *Deployer) memAvailable() int64 {
	if d.MemAvailable != nil {
		return d.MemAvailable()
	}
	return repository.MemAvailable()
}

func NewDeployer(docker DeployDocker, report DeployReporter, auth func(string) string) *Deployer {
	return &Deployer{Docker: docker, Report: report, RegistryAuth: auth, Converge: 5 * time.Minute, Poll: 2 * time.Second,
		Migrate: 15 * time.Minute, Build: 40 * time.Minute, BuildLogEvery: 5 * time.Second}
}

// migrateLogTail: las líneas de la migración que pasan al log del deploy.
const migrateLogTail = 200

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
	if job.Build != nil {
		// Construida aquí: no hay registro del que bajarla ni digest que
		// clavar (una imagen local no tiene RepoDigests). Se despliega
		// `repo:tag`, que es único por commit.
		if err := d.build(ctx, svc, job, log); err != nil {
			fail(prev, err)
			return
		}
	} else if !strings.Contains(job.Image, "@") {
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
	if job.MigrateCommand != "" {
		if err := d.migrate(ctx, svc, job, final, auth, log); err != nil {
			fail(prev, err)
			return
		}
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

// migrate corre el comando de migración como un job de Swarm copiado del
// servicio, con la imagen nueva, y espera a que acabe. El job se borra salga
// como salga: no se queda nada colgado en el servidor.
func (d *Deployer) migrate(ctx context.Context, svc *repository.ServiceState, job DeployJob, image, auth string, log func(string, ...any)) error {
	name := svc.Name + "-migrate-" + shortID(job.DeploymentID)
	log("migraciones: %s", job.MigrateCommand)
	id, err := d.Docker.CreateMigrationJob(ctx, svc.ID, name, image, job.MigrateCommand, auth)
	if err != nil {
		return err
	}
	defer func() {
		// Con su propio contexto: si el del deploy se canceló, el job se borra igual.
		_ = d.Docker.RemoveService(context.Background(), id)
	}()

	deadline := time.Now().Add(d.Migrate)
	var st repository.TaskState
	for {
		st, err = d.Docker.JobTask(ctx, id)
		if err != nil {
			return err
		}
		if st.Done() {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("las migraciones no acabaron en %s (sigue %q)", d.Migrate, st.State)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.Poll):
		}
	}
	if lines, err := d.Docker.JobLogs(ctx, id, migrateLogTail); err == nil {
		for _, l := range lines {
			log("  %s", l)
		}
	}
	if st.State != "complete" || st.ExitCode != 0 {
		msg := fmt.Sprintf("las migraciones fallaron (%s, código %d)", st.State, st.ExitCode)
		if st.Err != "" {
			msg += ": " + st.Err
		}
		return fmt.Errorf("%s; el servicio no se tocó", msg)
	}
	log("migraciones hechas")
	return nil
}

// buildTail recuerda hasta dónde se ha pasado el log de un build, y si en él
// algún paso murió matado (lo que hace el kernel al pasar del tope de memoria).
type buildTail struct {
	last   time.Time
	killed bool
}

// killedLine: cómo cuenta BuildKit un paso que se quedó sin memoria. Con el
// tope del constructor sale `ResourceExhausted: … cannot allocate memory`
// (medido con buildx 0.20 y BuildKit 0.33); si el kernel lo mata, código 137.
func killedLine(s string) bool {
	for _, m := range []string{"ResourceExhausted", "cannot allocate memory", "exit code: 137", "signal: killed"} {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// pull pasa al deploy las líneas posteriores a la última pasada, como mucho
// las `buildLogTail` más nuevas (un build de Next escupe miles de golpe, y lo
// que importa es dónde va). true si pasó alguna.
func (t *buildTail) pull(ctx context.Context, docker DeployDocker, id string, log func(string, ...any)) bool {
	lines, err := docker.JobLogsSince(ctx, id, t.last)
	if err != nil {
		return false
	}
	fresh := lines[:0:0]
	for _, l := range lines {
		// Docker corta por el instante y la del borde vuelve: fuera.
		if t.last.IsZero() || l.At.After(t.last) {
			fresh = append(fresh, l)
		}
	}
	if len(fresh) == 0 {
		return false
	}
	if n := len(fresh) - buildLogTail; n > 0 {
		log("  … %d líneas más", n)
		fresh = fresh[n:]
	}
	for _, l := range fresh {
		log("  %s", l.Text)
		if killedLine(l.Text) {
			t.killed = true
		}
	}
	t.last = fresh[len(fresh)-1].At
	return true
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// buildLogTail: las líneas del build que pasan al log del deploy. Un build de
// Next escribe miles; lo que importa es el final, donde está el error.
const buildLogTail = 400

// build construye la imagen del trabajo en este servidor con un job de Swarm
// y espera a que acabe. El job y el secret del token se borran salga como
// salga: no queda nada colgado, y el token no se queda en el servidor.
func (d *Deployer) build(ctx context.Context, svc *repository.ServiceState, job DeployJob, log func(string, ...any)) error {
	b := job.Build
	req := repository.BuildRequest{
		Repo: b.Repo, Sha: b.Sha, Dockerfile: b.Dockerfile, Context: b.Context,
		BuildArgs: b.BuildArgs, Image: job.Image,
	}
	// Sin saber cuánta memoria hay, se construye como antes, sin límites: un
	// tope inventado podría no dejar acabar ningún build. Con poca libre, no se
	// construye: un build que manda la base a la swap deja la web lenta.
	if total, err := d.Docker.HostMemory(ctx); err == nil {
		avail := d.memAvailable()
		mb, ok := repository.BuildMemoryMB(total, avail)
		if !ok {
			return fmt.Errorf("not enough free memory to build here: %d MB free; a build needs at least 1.5 GB without pushing what runs to swap", avail>>20)
		}
		req.MemoryMB = mb
		if mb > 0 {
			req.SwapMB = repository.BuildSwapMB(d.swapFree())
			log("memoria libre ahora: %d MB; tope del build: %d MB, más %d MB de swap propia", avail>>20, mb, req.SwapMB)
		}
	}
	script, err := repository.BuildScript(req)
	if err != nil {
		return err
	}
	if b.CloneToken == "" {
		return fmt.Errorf("el trabajo no trae con qué clonar %s", b.Repo)
	}
	// Una imagen hecha aquí sólo existe en este nodo.
	if n, err := d.Docker.NodeCount(ctx); err != nil {
		return err
	} else if n > 1 {
		return fmt.Errorf("este swarm tiene %d nodos y una imagen construida aquí sólo llega a uno; hace falta un registro", n)
	}

	secrets := make([]repository.BuildSecret, 0, len(b.BuildArgs)+1)
	for _, a := range b.BuildArgs {
		id, name, err := d.Docker.FindServiceSecret(ctx, svc.Name, a)
		if err != nil {
			return err
		}
		secrets = append(secrets, repository.BuildSecret{ID: id, Name: name, File: a})
	}
	tokenName := "cac_build_token_" + shortID(job.DeploymentID)
	tokenID, err := d.Docker.CreateSecret(ctx, tokenName, []byte(b.CloneToken), map[string]string{"cac.build.token": svc.Name})
	if err != nil {
		return err
	}
	// Después del job (va en el defer de abajo, que corre antes): Docker no
	// deja borrar un secret que monta un servicio.
	defer func() { _ = d.Docker.RemoveSecret(context.Background(), tokenID) }()
	secrets = append(secrets, repository.BuildSecret{ID: tokenID, Name: tokenName, File: repository.BuildTokenFile})

	log("construyendo %s@%s (%s)", b.Repo, shortID(b.Sha), job.Image)
	spec := repository.BuildJobSpec(svc.Name+"-build-"+shortID(job.DeploymentID), svc.Name, script, secrets)
	id, err := d.Docker.CreateJob(ctx, spec)
	if err != nil {
		return err
	}
	defer func() { _ = d.Docker.RemoveService(context.Background(), id) }()

	start := time.Now()
	deadline := start.Add(d.Build)
	// El log del build va pasando mientras corre: hasta la v6 sólo llegaba al
	// final (las últimas 400 líneas), y un build de diez minutos se veía como
	// dos líneas y nada más (boaty, 16-oct-2026).
	tail := &buildTail{}
	lastPull, lastNote := start, start
	var st repository.TaskState
	for {
		st, err = d.Docker.JobTask(ctx, id)
		if err != nil {
			return err
		}
		if st.Done() {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("el build no acabó en %s", d.Build)
		}
		if time.Since(lastPull) >= d.BuildLogEvery {
			if tail.pull(ctx, d.Docker, id, log) {
				lastNote = time.Now()
			}
			lastPull = time.Now()
		}
		// Un build puede callar minutos (un `npm install` sin salida): que el
		// log diga que sigue.
		if time.Since(lastNote) >= time.Minute {
			log("sigue construyendo (%s)", time.Since(start).Round(time.Second))
			lastNote = time.Now()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.Poll):
		}
	}
	// Lo que quede. Si nunca se pudo leer en vivo, las últimas líneas, como antes.
	if !tail.pull(ctx, d.Docker, id, log) && tail.last.IsZero() {
		if lines, err := d.Docker.JobLogs(ctx, id, buildLogTail); err == nil {
			for _, l := range lines {
				log("  %s", l)
			}
		}
	}
	if st.State != "complete" || st.ExitCode != 0 {
		msg := fmt.Sprintf("el build falló (%s, código %d)", st.State, st.ExitCode)
		if st.Err != "" {
			msg += ": " + st.Err
		}
		if req.MemoryMB > 0 && tail.killed {
			msg += fmt.Sprintf("; parece que se quedó sin memoria (el build tiene un tope de %d MB para no ahogar lo que corre en el servidor)", req.MemoryMB)
		}
		return fmt.Errorf("%s; el servicio no se tocó", msg)
	}
	log("construida %s en %s", job.Image, time.Since(start).Round(time.Second))
	return nil
}
