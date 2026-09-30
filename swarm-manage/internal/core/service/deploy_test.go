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
