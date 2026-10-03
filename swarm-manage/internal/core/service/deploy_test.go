package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
)

const repo = "ghcr.io/a/api"
const digest = "sha256:" + "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2"

// fakeDocker: un servicio en memoria, con lo que se le hizo.
type fakeDocker struct {
	mu        sync.Mutex
	svc       repository.ServiceState
	pullErr   error
	pulled    []string
	updatedTo string
	// Lo que dirá Swarm después de actualizar.
	after func(*repository.ServiceState)

	// El job de migración: con qué se creó, cómo acabará y si se borró.
	migImage, migCmd string
	migState         repository.TaskState
	migLogs          []string
	migRemoved       bool
	migCreated       bool
	// Si ya se había actualizado el servicio cuando se creó el job.
	updatedBeforeMig bool
}

func (f *fakeDocker) CreateMigrationJob(_ context.Context, from, name, image, cmd, _ string) (string, error) {
	f.migCreated, f.migImage, f.migCmd = true, image, cmd
	f.updatedBeforeMig = f.updatedTo != ""
	return "job-1", nil
}
func (f *fakeDocker) JobTask(context.Context, string) (repository.TaskState, error) {
	return f.migState, nil
}
func (f *fakeDocker) JobLogs(context.Context, string, int) ([]string, error) { return f.migLogs, nil }
func (f *fakeDocker) RemoveService(_ context.Context, id string) error {
	if id == "job-1" {
		f.migRemoved = true
	}
	return nil
}

func (f *fakeDocker) FindService(_ context.Context, name string) (*repository.ServiceState, error) {
	if name != f.svc.Name {
		return nil, errors.New("no existe")
	}
	s := f.svc
	return &s, nil
}
func (f *fakeDocker) InspectService(context.Context, string) (*repository.ServiceState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.svc
	return &s, nil
}
func (f *fakeDocker) PullImage(_ context.Context, image, _ string) error {
	f.pulled = append(f.pulled, image)
	return f.pullErr
}
func (f *fakeDocker) ImageDigest(_ context.Context, image string) (string, error) {
	name, _, _ := strings.Cut(image, ":abc")
	return name + "@" + digest, nil
}
func (f *fakeDocker) UpdateServiceImage(_ context.Context, id string, version int, image, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if version != f.svc.Version {
		return errors.New("versión vieja")
	}
	f.updatedTo = image
	f.svc.Image = image
	f.svc.UpdateState = "completed"
	if f.after != nil {
		f.after(&f.svc)
	}
	return nil
}

type fakeReport struct {
	lines  []string
	finish *FinishReport
}

func (r *fakeReport) Log(_ context.Context, _, line string) { r.lines = append(r.lines, line) }
func (r *fakeReport) Finish(_ context.Context, _ string, f FinishReport) error {
	r.finish = &f
	return nil
}

func deployer(d *fakeDocker, r *fakeReport) *Deployer {
	dep := NewDeployer(d, r, nil)
	dep.Converge, dep.Poll = 200*time.Millisecond, 5*time.Millisecond
	return dep
}

func job(image string) json.RawMessage {
	raw, _ := json.Marshal(DeployJob{DeploymentID: "d-1", Stack: "api", ServiceName: "api_app", ImageRepo: repo, Image: image})
	return raw
}

func servicio() repository.ServiceState {
	return repository.ServiceState{ID: "s1", Name: "api_app", Stack: "api", Version: 7, Image: repo + ":viejo"}
}

// El camino bueno: baja antes de tocar, clava el digest, cambia la imagen y
// dice qué había antes y qué quedó.
func TestADeployPullsPinsUpdatesAndReports(t *testing.T) {
	d := &fakeDocker{svc: servicio()}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))

	if r.finish == nil || r.finish.Status != "succeeded" {
		t.Fatalf("no acabó bien: %+v %v", r.finish, r.lines)
	}
	want := repo + ":abc1234@" + digest
	if d.updatedTo != want || r.finish.FinalImage != want {
		t.Errorf("quedó %q (dice %q), se esperaba %q", d.updatedTo, r.finish.FinalImage, want)
	}
	if r.finish.PreviousImage != repo+":viejo" {
		t.Errorf("lo de antes es %q", r.finish.PreviousImage)
	}
	if len(d.pulled) != 1 || d.pulled[0] != repo+":abc1234" {
		t.Errorf("bajó %v", d.pulled)
	}
}

// Una imagen que no es del repositorio del trabajo no llega ni a Docker.
func TestAnImageOutsideTheRepoNeverReachesDocker(t *testing.T) {
	for _, img := range []string{"ghcr.io/otro/api:abc1234", repo + "-x:abc1234", repo + ":abc; rm -rf /", repo + ":--mount"} {
		d := &fakeDocker{svc: servicio()}
		r := &fakeReport{}
		deployer(d, r).Run(context.Background(), "d-1", job(img))
		if r.finish == nil || r.finish.Status != "failed" {
			t.Errorf("%q: se esperaba failed, fue %+v", img, r.finish)
		}
		if len(d.pulled) != 0 || d.updatedTo != "" {
			t.Errorf("%q llegó a Docker: pull %v, update %q", img, d.pulled, d.updatedTo)
		}
	}
}

// Un servicio de otro stack con el mismo nombre no se toca.
func TestAServiceOfAnotherStackIsNotTouched(t *testing.T) {
	s := servicio()
	s.Stack = "otro"
	d := &fakeDocker{svc: s}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))
	if r.finish.Status != "failed" || d.updatedTo != "" {
		t.Errorf("tocó un servicio de otro stack: %+v, update %q", r.finish, d.updatedTo)
	}
}

// Si la imagen no se puede bajar, el servicio viejo sigue en pie.
func TestAFailedPullLeavesTheServiceAlone(t *testing.T) {
	d := &fakeDocker{svc: servicio(), pullErr: errors.New("pull access denied")}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))
	if r.finish.Status != "failed" || d.updatedTo != "" {
		t.Errorf("con el pull fallido se actualizó igual: %+v %q", r.finish, d.updatedTo)
	}
	if !strings.Contains(r.finish.Error, "credenciales") {
		t.Errorf("un «denied» sin credenciales tiene que decir cómo arreglarlo: %q", r.finish.Error)
	}
}

// Swarm puede deshacer una actualización él solo y seguir contestando 200.
func TestASwarmRollbackIsAFailedDeploy(t *testing.T) {
	d := &fakeDocker{svc: servicio(), after: func(s *repository.ServiceState) {
		s.UpdateState, s.UpdateMessage = "rollback_completed", "task failed healthcheck"
		s.Image = repo + ":viejo"
	}}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))
	if r.finish.Status != "failed" || !strings.Contains(r.finish.Error, "healthcheck") {
		t.Errorf("un rollback de Swarm contó como bueno: %+v", r.finish)
	}
}

// «Terminado» con otra imagen tampoco es un deploy.
func TestCompletedWithAnotherImageIsAFailedDeploy(t *testing.T) {
	d := &fakeDocker{svc: servicio(), after: func(s *repository.ServiceState) { s.Image = repo + ":otra" }}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))
	if r.finish.Status != "failed" {
		t.Errorf("terminó con otra imagen y contó como bueno: %+v", r.finish)
	}
}

// Una imagen con digest (un rollback) no se vuelve a bajar: ya está clavada.
func TestARollbackToAPinnedImageDoesNotPull(t *testing.T) {
	d := &fakeDocker{svc: servicio()}
	r := &fakeReport{}
	img := repo + ":viejo@" + digest
	deployer(d, r).Run(context.Background(), "d-1", job(img))
	if r.finish.Status != "succeeded" || d.updatedTo != img || len(d.pulled) != 0 {
		t.Errorf("rollback: %+v, update %q, pull %v", r.finish, d.updatedTo, d.pulled)
	}
}

// Si Swarm no termina, el deploy falla y lo dice; no se queda esperando.
func TestADeployThatNeverConvergesFails(t *testing.T) {
	d := &fakeDocker{svc: servicio(), after: func(s *repository.ServiceState) { s.UpdateState = "updating" }}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))
	if r.finish.Status != "failed" || !strings.Contains(r.finish.Error, "no terminó") {
		t.Errorf("un deploy colgado: %+v", r.finish)
	}
}

func jobWithMigration(image, cmd string) json.RawMessage {
	raw, _ := json.Marshal(DeployJob{DeploymentID: "d-1", Stack: "api", ServiceName: "api_app", ImageRepo: repo, Image: image, MigrateCommand: cmd})
	return raw
}

// Las migraciones corren antes de tocar el servicio, con la imagen nueva ya
// clavada; su salida va al log; el job se borra.
func TestMigrationsRunBeforeTheUpdateWithTheNewImage(t *testing.T) {
	d := &fakeDocker{svc: servicio(), migState: repository.TaskState{State: "complete"}, migLogs: []string{"applied 3 migrations"}}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", jobWithMigration(repo+":abc1234", "npx prisma migrate deploy"))

	if r.finish == nil || r.finish.Status != "succeeded" {
		t.Fatalf("no acabó bien: %+v %v", r.finish, r.lines)
	}
	if !d.migCreated || d.updatedBeforeMig {
		t.Errorf("la migración no corrió antes del update (creada %v, después %v)", d.migCreated, d.updatedBeforeMig)
	}
	if d.migImage != repo+":abc1234@"+digest || d.migCmd != "npx prisma migrate deploy" {
		t.Errorf("job con %q / %q", d.migImage, d.migCmd)
	}
	if !d.migRemoved {
		t.Error("el job de migración se quedó en el servidor")
	}
	if !strings.Contains(strings.Join(r.lines, "\n"), "applied 3 migrations") {
		t.Errorf("la salida de la migración no está en el log: %v", r.lines)
	}
}

// Una migración que falla deja el servicio como estaba, y el job se borra.
func TestAFailedMigrationLeavesTheServiceAlone(t *testing.T) {
	for name, st := range map[string]repository.TaskState{
		"código 1":  {State: "complete", ExitCode: 1},
		"falló":     {State: "failed", ExitCode: 2, Err: "task: non-zero exit (2)"},
		"rechazada": {State: "rejected", Err: "no suitable node"},
	} {
		t.Run(name, func(t *testing.T) {
			d := &fakeDocker{svc: servicio(), migState: st}
			r := &fakeReport{}
			deployer(d, r).Run(context.Background(), "d-1", jobWithMigration(repo+":abc1234", "migrate"))
			if r.finish == nil || r.finish.Status != "failed" {
				t.Fatalf("una migración %s acabó %+v", name, r.finish)
			}
			if d.updatedTo != "" {
				t.Errorf("con la migración %s se tocó el servicio: %s", name, d.updatedTo)
			}
			if !d.migRemoved {
				t.Error("el job de migración se quedó en el servidor")
			}
		})
	}
}

// Una migración que no acaba tiene tope.
func TestAStuckMigrationTimesOut(t *testing.T) {
	d := &fakeDocker{svc: servicio(), migState: repository.TaskState{State: "running"}}
	r := &fakeReport{}
	dep := deployer(d, r)
	dep.Migrate = 30 * time.Millisecond
	dep.Run(context.Background(), "d-1", jobWithMigration(repo+":abc1234", "migrate"))
	if r.finish == nil || r.finish.Status != "failed" || d.updatedTo != "" || !d.migRemoved {
		t.Errorf("una migración colgada: %+v, actualizado %q, borrado %v", r.finish, d.updatedTo, d.migRemoved)
	}
}

// Sin comando no hay job.
func TestNoCommandNoMigration(t *testing.T) {
	d := &fakeDocker{svc: servicio()}
	r := &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", job(repo+":abc1234"))
	if d.migCreated {
		t.Error("se creó un job de migración sin comando")
	}
}
