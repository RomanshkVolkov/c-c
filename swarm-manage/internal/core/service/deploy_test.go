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

	// El build (v6): nodos del swarm, secrets del servicio por nombre, y lo
	// que se creó y se borró.
	nodes          int
	serviceSecrets map[string]string
	jobSpec        map[string]any
	secretsMade    map[string][]byte
	secretsGone    []string
	jobsGone       []string

	// El log en vivo del build: `running` preguntas sigue corriendo, y en la
	// pregunta i aparecen las líneas de `steps[i]`.
	running   int
	taskCalls int
	steps     [][]repository.LogLine
	written   []repository.LogLine

	// La memoria de la máquina; 0, que no se sabe.
	memory int64
}

func (f *fakeDocker) HostMemory(context.Context) (int64, error) {
	if f.memory == 0 {
		return 0, errors.New("sin /info")
	}
	return f.memory, nil
}

func (f *fakeDocker) NodeCount(context.Context) (int, error) {
	if f.nodes == 0 {
		return 1, nil
	}
	return f.nodes, nil
}
func (f *fakeDocker) FindServiceSecret(_ context.Context, service, key string) (string, string, error) {
	name, ok := f.serviceSecrets[key]
	if !ok || service != f.svc.Name {
		return "", "", errors.New("no tiene el secret " + key)
	}
	return "id-" + name, name, nil
}
func (f *fakeDocker) CreateSecret(_ context.Context, name string, data []byte, _ map[string]string) (string, error) {
	if f.secretsMade == nil {
		f.secretsMade = map[string][]byte{}
	}
	f.secretsMade[name] = data
	return "id-" + name, nil
}
func (f *fakeDocker) RemoveSecret(_ context.Context, id string) error {
	f.secretsGone = append(f.secretsGone, id)
	return nil
}
func (f *fakeDocker) CreateJob(_ context.Context, spec map[string]any) (string, error) {
	f.jobSpec = spec
	return "build-1", nil
}

func (f *fakeDocker) CreateMigrationJob(_ context.Context, from, name, image, cmd, _ string) (string, error) {
	f.migCreated, f.migImage, f.migCmd = true, image, cmd
	f.updatedBeforeMig = f.updatedTo != ""
	return "job-1", nil
}
func (f *fakeDocker) JobTask(context.Context, string) (repository.TaskState, error) {
	if f.taskCalls < len(f.steps) {
		f.written = append(f.written, f.steps[f.taskCalls]...)
	}
	f.taskCalls++
	if f.taskCalls <= f.running {
		return repository.TaskState{State: "running"}, nil
	}
	return f.migState, nil
}

// Como Docker: desde `since` **incluido**, que es por lo que la línea del
// borde vuelve.
func (f *fakeDocker) JobLogsSince(_ context.Context, _ string, since time.Time) ([]repository.LogLine, error) {
	var out []repository.LogLine
	for _, l := range f.written {
		if !l.At.Before(since) {
			out = append(out, l)
		}
	}
	return out, nil
}
func (f *fakeDocker) JobLogs(context.Context, string, int) ([]string, error) { return f.migLogs, nil }
func (f *fakeDocker) RemoveService(_ context.Context, id string) error {
	if id == "job-1" {
		f.migRemoved = true
	}
	f.jobsGone = append(f.jobsGone, id)
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
	// Si está, apunta junto a cada línea cuántas preguntas llevaba el build.
	stamp  func() int
	stamps []int
}

func (r *fakeReport) Log(_ context.Context, _, line string) {
	r.lines = append(r.lines, line)
	if r.stamp != nil {
		r.stamps = append(r.stamps, r.stamp())
	}
}
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

// ─── Construir en el servidor (v6) ────────────────────────────────────────────

func buildJob() json.RawMessage {
	raw, _ := json.Marshal(DeployJob{
		DeploymentID: "d-1", Stack: "api", ServiceName: "api_app", ImageRepo: repo, Image: repo + ":abc1234",
		Build: &BuildSpec{Repo: "a/api", Sha: "abc1234def5678abc1234def5678abc1234def56", Dockerfile: "Dockerfile",
			BuildArgs: []string{"DATABASE_URL"}, CloneToken: "ghs_x"},
	})
	return raw
}

func buildDocker() *fakeDocker {
	return &fakeDocker{
		svc:            repository.ServiceState{ID: "s1", Name: "api_app", Stack: "api", Version: 7, Image: repo + ":old"},
		serviceSecrets: map[string]string{"DATABASE_URL": "cac_DATABASE_URL_0011223344556677"},
		migState:       repository.TaskState{State: "complete"},
	}
}

// Un deploy con build construye aquí y despliega `repo:tag` sin bajarlo ni
// clavar digest (una imagen local no tiene); el token va en un secret que se
// borra, y el job también.
// Mutantes: bajar la imagen igual; no borrar el secret del token; no borrar
// el job; montar el secret que no es del servicio.
func TestABuildDeploysTheLocalImage(t *testing.T) {
	d, r := buildDocker(), &fakeReport{}
	deployer(d, r).Run(context.Background(), "d-1", buildJob())
	if r.finish == nil || r.finish.Status != "succeeded" || r.finish.FinalImage != repo+":abc1234" {
		t.Fatalf("acabó %+v\n%s", r.finish, strings.Join(r.lines, "\n"))
	}
	if len(d.pulled) != 0 {
		t.Fatalf("bajó una imagen construida aquí: %v", d.pulled)
	}
	if string(d.secretsMade["cac_build_token_d-1"]) != "ghs_x" {
		t.Fatalf("el token: %v", d.secretsMade)
	}
	if strings.Join(d.secretsGone, ",") != "id-cac_build_token_d-1" || strings.Join(d.jobsGone, ",") != "build-1" {
		t.Fatalf("quedó algo: secrets borrados %v, jobs borrados %v", d.secretsGone, d.jobsGone)
	}
	cs := d.jobSpec["TaskTemplate"].(map[string]any)["ContainerSpec"].(map[string]any)
	script := cs["Command"].([]string)[2]
	if strings.Contains(script, "ghs_x") {
		t.Fatalf("el token en el guion:\n%s", script)
	}
}

// El log del build llega mientras construye, no al final, y cada línea una
// vez aunque Docker devuelva la del borde.
// Mutantes: pasar el log sólo al acabar (llega tarde); no descartar la del
// borde (se repite); caer a las últimas líneas habiendo leído en vivo.
func TestTheBuildLogArrivesWhileItBuilds(t *testing.T) {
	d, r := buildDocker(), &fakeReport{}
	t0 := time.Date(2026, 10, 16, 15, 0, 0, 0, time.UTC)
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }
	d.running = 4
	d.steps = [][]repository.LogLine{
		{{At: at(1), Text: "#1 load build definition"}},
		{{At: at(2), Text: "#5 RUN npm ci"}, {At: at(3), Text: "#5 added 812 packages"}},
		nil,
		{{At: at(9), Text: "#7 RUN next build"}},
	}
	d.migLogs = []string{"lo que daba el log de antes, al final"}
	r.stamp = func() int { return d.taskCalls }
	dep := deployer(d, r)
	dep.BuildLogEvery = 0
	dep.Run(context.Background(), "d-1", buildJob())
	if r.finish == nil || r.finish.Status != "succeeded" {
		t.Fatalf("acabó %+v\n%s", r.finish, strings.Join(r.lines, "\n"))
	}
	all := strings.Join(r.lines, "\n")
	for _, want := range []string{"#1 load build definition", "#5 RUN npm ci", "#5 added 812 packages", "#7 RUN next build"} {
		if n := strings.Count(all, want); n != 1 {
			t.Errorf("%q salió %d veces:\n%s", want, n, all)
		}
	}
	for i, l := range r.lines {
		if strings.Contains(l, "#5 RUN npm ci") && r.stamps[i] > d.running {
			t.Errorf("la línea del npm llegó con el build acabado (pregunta %d de %d)", r.stamps[i], d.running)
		}
	}
	if strings.Contains(all, "lo que daba el log de antes") {
		t.Errorf("leyendo en vivo, también pasó la cola de antes:\n%s", all)
	}
}

// El build lleva el tope de la máquina en la que corre; y si un paso muere
// matado, el error dice que fue la memoria y cuál era el tope.
// Mutantes: no pasarle la memoria al guion; no mirar si lo mataron.
func TestTheBuildIsCappedToTheMachineAndSaysWhenItRanOut(t *testing.T) {
	d, r := buildDocker(), &fakeReport{}
	d.memory = 8 << 30
	d.running = 1
	d.steps = [][]repository.LogLine{{{At: time.Unix(1, 0), Text: "#14 ERROR: process \"/bin/sh -c next build\" did not complete successfully: exit code: 137"}}}
	d.migState = repository.TaskState{State: "failed", ExitCode: 1}
	dep := deployer(d, r)
	dep.BuildLogEvery = 0
	dep.MemAvailable = func() int64 { return 7 << 30 }
	// 3 GB de swap libre: el build puede usar 2,5 (deja medio GB).
	dep.SwapFree = func() int64 { return 3 << 30 }
	dep.Run(context.Background(), "d-1", buildJob())
	cs := d.jobSpec["TaskTemplate"].(map[string]any)["ContainerSpec"].(map[string]any)
	if script := cs["Command"].([]string)[2]; !strings.Contains(script, "memory=6144m") || !strings.Contains(script, "memory-swap=8704m") {
		t.Errorf("el guion no lleva el tope de la máquina y su swap propia:\n%s", script)
	}
	if r.finish == nil || r.finish.Status != "failed" || !strings.Contains(r.finish.Error, "sin memoria") || !strings.Contains(r.finish.Error, "6144 MB") {
		t.Fatalf("acabó %+v", r.finish)
	}
}

// Con poca memoria libre no se construye: el deploy falla diciéndolo, antes
// de crear nada, en vez de mandar a la swap lo que corre (la web iba lenta).
// Mutante: construir igual con el suelo de 1 GB.
func TestABuildWithoutFreeMemoryDoesNotStart(t *testing.T) {
	d, r := buildDocker(), &fakeReport{}
	d.memory = 8 << 30
	dep := deployer(d, r)
	dep.MemAvailable = func() int64 { return 1200 << 20 }
	dep.Run(context.Background(), "d-1", buildJob())
	if r.finish == nil || r.finish.Status != "failed" || !strings.Contains(r.finish.Error, "not enough free memory") {
		t.Fatalf("acabó %+v", r.finish)
	}
	if d.jobSpec != nil || len(d.secretsMade) != 0 || d.updatedTo != "" {
		t.Fatalf("empezó igual: job %v, secrets %v, actualizado a %q", d.jobSpec != nil, d.secretsMade, d.updatedTo)
	}
}

// Si el build falla, el servicio no se toca y no queda nada en el servidor.
// Mutantes: actualizar igual; dejar el secret del token.
func TestAFailedBuildLeavesTheServiceAndNothingBehind(t *testing.T) {
	d, r := buildDocker(), &fakeReport{}
	d.migState = repository.TaskState{State: "failed", ExitCode: 1}
	deployer(d, r).Run(context.Background(), "d-1", buildJob())
	if r.finish == nil || r.finish.Status != "failed" || d.updatedTo != "" {
		t.Fatalf("acabó %+v, actualizado a %q", r.finish, d.updatedTo)
	}
	if len(d.secretsGone) != 1 || len(d.jobsGone) != 1 {
		t.Fatalf("quedó algo: %v %v", d.secretsGone, d.jobsGone)
	}
}

// Con varios nodos, una imagen hecha aquí no llega a los otros: se rechaza
// antes de construir. Y un build arg que el servicio no tiene, también.
// Mutantes: no mirar los nodos; seguir sin el secret.
func TestABuildRefusesWhatItCannotDo(t *testing.T) {
	d, r := buildDocker(), &fakeReport{}
	d.nodes = 2
	deployer(d, r).Run(context.Background(), "d-1", buildJob())
	if r.finish == nil || r.finish.Status != "failed" || d.jobSpec != nil || !strings.Contains(r.finish.Error, "nodos") {
		t.Fatalf("con dos nodos: %+v", r.finish)
	}

	d, r = buildDocker(), &fakeReport{}
	d.serviceSecrets = map[string]string{}
	deployer(d, r).Run(context.Background(), "d-1", buildJob())
	if r.finish == nil || r.finish.Status != "failed" || d.jobSpec != nil {
		t.Fatalf("sin el secret: %+v", r.finish)
	}
}
