package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/events"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Construir en el servidor (14-oct-2026): un push a la rama de un servicio lo
construye y lo despliega, sin un CI que publique la imagen. Sobre el fixture de
la App (repo 100 = dwit/api, de la org-1), con el servicio pasado a construir
en el servidor desde la rama `main`, y un agente v6.
*/

func hostBuildSetup(t *testing.T, mode string) *appFixture {
	t.Helper()
	f, cleanup := appSetup(t, mode)
	t.Cleanup(cleanup)
	if err := f.db.AutoMigrate(&domain.DeployableSecretRef{}); err != nil {
		t.Fatal(err)
	}
	f.db.Exec(`UPDATE servers SET agent_version = ? WHERE id = 'srv-1'`, domain.AgentVersionBuilds)
	f.deploys.WithRepoTokens(f.ghSvc)
	main, on := "main", true
	d, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", Environment: "prod", RepoFullName: "dwit/api", OnCINotify: mode,
		Branch: &main, BuildOnHost: &on,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.d = d
	return f
}

func pushTo(ref, after string) string {
	return fmt.Sprintf(`{"ref":%q,"after":%q,"installation":{"id":5},"pusher":{"name":"ana"},
		"repository":{"id":100,"full_name":"dwit/api","default_branch":"main"},"commits":[]}`, ref, after)
}

func (f *appFixture) deploymentsOf(t *testing.T) []domain.Deployment {
	t.Helper()
	var out []domain.Deployment
	f.db.Where("deployable_id = ?", f.d.ID).Order("created_at").Find(&out)
	return out
}

// Un push a la rama del servicio lo construye y lo despliega; a otra rama, no.
// Mutantes: no mirar la rama en `deploysOnPush`; `BuildsOn` siempre true.
func TestAPushToTheServiceBranchBuildsAndDeploys(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	f.hook(t, "push", "p-1", pushTo("refs/heads/staging", shaOld))
	if deps := f.deploymentsOf(t); len(deps) != 0 {
		t.Fatalf("un push a otra rama desplegó: %+v", deps)
	}
	f.hook(t, "push", "p-2", pushTo("refs/heads/main", shaNew))
	deps := f.deploymentsOf(t)
	if len(deps) != 1 || deps[0].BuildSha != shaNew || deps[0].RequestedBy != domain.DeployByGitHub ||
		// Con el nombre del servicio detrás del sha: un build en el servidor
		// no puede compartir tag con el del CI ni con otro servicio (cac#185).
		deps[0].Image != "ghcr.io/dwit/api:"+shaNew+"-beta_app" {
		t.Fatalf("deploys: %+v", deps)
	}
	var b domain.ImageBuild
	f.db.First(&b, "deployable_id = ?", f.d.ID)
	if b.Source != domain.BuildSourceHost || b.Ref != "refs/heads/main" || b.Actor != "ana" ||
		b.Image != "ghcr.io/dwit/api:"+shaNew+"-beta_app" {
		t.Fatalf("la versión: %+v", b)
	}
	// El mismo push otra vez (GitHub reentrega) no es otro deploy.
	f.hook(t, "push", "p-3", pushTo("refs/heads/main", shaNew))
	if deps := f.deploymentsOf(t); len(deps) != 1 {
		t.Fatalf("una reentrega encoló otro: %d", len(deps))
	}
}

// En modo `record`, el push sólo apunta la versión; y (abajo) un repo de otra
// org con el mismo nombre no dispara nada. Mutantes: encolar en `record`;
// quitar `orgRepo`.
func TestAPushOnlyBuildsWhatItShould(t *testing.T) {
	f := hostBuildSetup(t, "record")
	f.hook(t, "push", "p-1", pushTo("refs/heads/main", shaNew))
	var builds int64
	f.db.Model(&domain.ImageBuild{}).Count(&builds)
	if builds != 1 || len(f.deploymentsOf(t)) != 0 {
		t.Fatalf("en record: %d versiones, %d deploys", builds, len(f.deploymentsOf(t)))
	}
}

func TestAPushOfAnotherOrgsRepoBuildsNothing(t *testing.T) {
	g := hostBuildSetup(t, "deploy")
	g.db.Model(&domain.GitHubRepo{}).Where("repo_id = 100").Update("org_id", "org-2")
	g.hook(t, "push", "p-1", pushTo("refs/heads/main", shaNew))
	if deps := g.deploymentsOf(t); len(deps) != 0 {
		t.Fatalf("un push del repo de otra org desplegó: %+v", deps)
	}
}

// Prod y test en el mismo repo: un aviso del CI de otra rama no es para este
// servicio. Mutante: sin el filtro de rama en `Notice`.
func TestANoticeOfAnotherBranchIsSkipped(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	main := "main"
	d, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", Environment: "prod", RepoFullName: "dwit/api", OnCINotify: "deploy", Branch: &main,
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := f.deploys.Notice(d, domain.DeployNotice{Sha: shaNew, Ref: "refs/heads/staging"}, "ci")
	if err != nil {
		t.Fatal(err)
	}
	var builds int64
	f.db.Model(&domain.ImageBuild{}).Count(&builds)
	if res.Deploy != "skipped" || res.Reason != "other-branch" || builds != 0 {
		t.Fatalf("aviso de otra rama: %+v, %d versiones", res, builds)
	}
	if res, _ := f.deploys.Notice(d, domain.DeployNotice{Sha: shaNew, Ref: "refs/heads/main"}, "ci"); res.Deploy != "queued" {
		t.Fatalf("el de su rama: %+v", res)
	}
}

// A un agente anterior a la v6 no se le encola un build: lo ignoraría y
// desplegaría una imagen que no existe. Mutante: sin la compuerta.
func TestAnOldAgentIsNotGivenABuild(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	f.db.Exec(`UPDATE servers SET agent_version = ? WHERE id = 'srv-1'`, domain.AgentVersionBuilds-1)
	if _, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, ""); !errors.Is(err, service.ErrAgentCannotBuild) {
		t.Fatalf("a un agente v5: %v", err)
	}
	res, err := f.deploys.PushBuild(f.d, shaNew, "refs/heads/main", "ana")
	if err != nil || res.Deploy != "skipped" || res.Reason != "agent-cannot-build" {
		t.Fatalf("el push con agente v5: %+v %v", res, err)
	}
	// Construir es de un commit entero: con uno corto no hay qué clonar.
	f.db.Exec(`UPDATE servers SET agent_version = ? WHERE id = 'srv-1'`, domain.AgentVersionBuilds)
	if _, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew[:7], ""); !errors.Is(err, service.ErrBuildNeedsFullSha) {
		t.Fatalf("con sha corto: %v", err)
	}
}

// El trabajo que recibe el agente lleva qué construir, con qué clonar y los
// **nombres** de los build args —los de build y los de los dos usos, no los de
// runtime—, y ningún valor ni referencia de 1Password.
// Mutantes: incluir los de runtime; dejar fuera los de los dos usos; no poner
// el token.
func TestTheBuildJobCarriesNamesNotValues(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	ctx := "boat"
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", Environment: "prod", RepoFullName: "dwit/api", OnCINotify: "deploy", BuildContext: &ctx,
	}); err != nil {
		t.Fatal(err)
	}
	refs := service.NewSecretRefService(repository.NewSecretRefRepository(f.db))
	if _, err := refs.Replace(f.d, domain.PutSecretRefsRequest{Refs: []domain.SecretRefInput{
		{Name: "DATABASE_URL", OpRef: "op://dwit/Boaty/DATABASE_URL", Usage: "both"},
		{Name: "NEXT_PUBLIC_STRIPE_KEY", OpRef: "op://dwit/Boaty/stripe", Usage: "build"},
		{Name: "MJ_APIKEY_PRIVATE", OpRef: "op://dwit/Boaty/mj"},
	}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, ""); err != nil {
		t.Fatal(err)
	}
	job, err := f.deploys.Claim("srv-1")
	if err != nil || job == nil || job.DeployData().Build == nil {
		t.Fatalf("sin build: %+v %v", job, err)
	}
	b := job.DeployData().Build
	if b.Repo != "dwit/api" || b.Sha != shaNew || b.Dockerfile != "Dockerfile" || b.Context != "boat" ||
		b.CloneToken != "ghs_prueba" || strings.Join(b.BuildArgs, ",") != "DATABASE_URL,NEXT_PUBLIC_STRIPE_KEY" {
		t.Fatalf("el build: %+v", b)
	}
	raw, _ := json.Marshal(job)
	if strings.Contains(string(raw), "op://") {
		t.Fatalf("el trabajo lleva referencias de 1Password: %s", raw)
	}
}

// Sin con qué clonar, el deploy falla al reclamarlo y con su motivo, en vez de
// mandarle al agente un trabajo que no puede hacer. Mutante: mandarlo igual.
func TestABuildWithoutACloneTokenFailsUpFront(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	if _, _, err := f.deploys.RequestDeploy(f.d, domain.DeployByUser, "u-1", shaNew, ""); err != nil {
		t.Fatal(err)
	}
	// La instalación ya no ve el repo.
	f.db.Exec(`DELETE FROM git_hub_repos WHERE repo_id = 100`)
	job, err := f.deploys.Claim("srv-1")
	if err != nil || job != nil {
		t.Fatalf("se mandó el trabajo: %+v %v", job, err)
	}
	deps := f.deploymentsOf(t)
	if len(deps) != 1 || deps[0].Status != domain.DeployFailed || deps[0].Error != service.ErrNoCloneToken.Error() {
		t.Fatalf("el deploy: %+v", deps)
	}
}

// Un deploy que construye tiene más plazo antes de darse por perdido: un build
// de Next pasa de los quince minutos. Mutante: un solo plazo para todos.
func TestABuildingDeployHasLongerToFinish(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	repo := repository.NewDeployRepository(f.db)
	// Dos servicios: el índice deja un solo deploy vivo por servicio.
	other := *f.d
	other.ID = "dep-other"
	if err := f.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	started := time.Now().Add(-20 * time.Minute)
	for _, x := range []struct{ deployable, sha string }{{f.d.ID, ""}, {other.ID, shaNew}} {
		dep := &domain.Deployment{OrgID: "org-1", DeployableID: x.deployable, ServerID: "srv-1", Image: "ghcr.io/dwit/api:x",
			RequestedBy: domain.DeployByUser, Status: domain.DeployRunning, BuildSha: x.sha, StartedAt: &started}
		dep.ID = "run-" + x.deployable[:8]
		if err := f.db.Create(dep).Error; err != nil {
			t.Fatal(err)
		}
	}
	plain, err := repo.ExpireStale(f.d.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	building, err := repo.ExpireStale(other.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) != 1 || len(building) != 0 {
		t.Fatalf("a los 20 min caducaron %d sin build y %d con build", len(plain), len(building))
	}
}

// Lo nuevo del servicio se valida y sobrevive a una app que no lo manda.
// Mutantes: aceptar `..` en la ruta; borrar la rama si no viene; construir sin
// repo.
func TestTheBuildSettingsAreCheckedAndKept(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	bad, up := "../etc", "main..x"
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy", Dockerfile: &bad,
	}); !errors.Is(err, service.ErrBadBuildPath) {
		t.Fatalf("ruta fuera del repo: %v", err)
	}
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy", Branch: &up,
	}); !errors.Is(err, service.ErrBadBranch) {
		t.Fatalf("rama mala: %v", err)
	}
	// Una app que no sabe del build no lo apaga ni le quita la rama.
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy",
	}); err != nil {
		t.Fatal(err)
	}
	var stored domain.Deployable
	f.db.First(&stored, "id = ?", f.d.ID)
	if !stored.BuildOnHost || stored.Branch != "main" {
		t.Fatalf("se perdió el build: %+v", stored)
	}
	if _, err := f.deploys.UpdateDeployable(&stored, domain.UpdateDeployableRequest{
		Name: "api", OnCINotify: "deploy",
	}); !errors.Is(err, service.ErrBuildNeedsRepo) {
		t.Fatalf("construir sin repo: %v", err)
	}
	// `.` es la raíz, como en `docker build .`: cuenta como vacía.
	// Mutante: guardarla tal cual (el contexto remoto acabaría en `#sha:.`).
	dot := "./"
	d, err := f.deploys.UpdateDeployable(&stored, domain.UpdateDeployableRequest{
		Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy", BuildContext: &dot,
	})
	if err != nil || d.BuildContext != "" {
		t.Fatalf("la carpeta «./»: %q %v", d.BuildContext, err)
	}
	refs := service.NewSecretRefService(repository.NewSecretRefRepository(f.db))
	if _, err := refs.Replace(f.d, domain.PutSecretRefsRequest{Refs: []domain.SecretRefInput{
		{Name: "X", OpRef: "op://a/b/c", Usage: "siempre"},
	}}); !errors.Is(err, service.ErrBadSecretUsage) {
		t.Fatalf("uso desconocido: %v", err)
	}
}

// El workflow que publica la imagen se elige de los del repo: sólo los suyos y
// en uso, y sólo de un repo de la org. Mutantes: incluir los deshabilitados;
// incluir los de GitHub (`dynamic/…`); no mirar la org.
func TestTheRepoWorkflowsAreListed(t *testing.T) {
	f, cleanup := appSetup(t, "deploy")
	defer cleanup()
	member := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	rec := f.as(t, "GET", "/api/v1/organizations/org-1/github/workflows?repo=DWIT/api", "", member)
	var out domain.APIResponse[[]service.RepoWorkflow]
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	got := []string{}
	for _, w := range out.Data {
		got = append(got, w.File)
	}
	if rec.Code != 200 || strings.Join(got, ",") != "prod.yml,tests.yml" {
		t.Fatalf("workflows → %d %s", rec.Code, rec.Body.String())
	}
	other := domain.OrgMembershipClaim{OrgID: "org-2", Role: domain.OrgRoleMember}
	if rec := f.as(t, "GET", "/api/v1/organizations/org-2/github/workflows?repo=dwit/api", "", other); rec.Code != 404 {
		t.Fatalf("el repo de otra org → %d", rec.Code)
	}
}

// Los build args se leen del Dockerfile del servicio, en su rama y en su
// carpeta, para proponerlos como secrets del build. Mutantes: leer de la rama
// por defecto; no tener en cuenta la carpeta.
func TestTheDockerfileArgsAreRead(t *testing.T) {
	f := hostBuildSetup(t, "deploy")
	member := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	path := "/api/v1/servers/srv-1/deployables/" + f.d.ID + "/build-args"
	rec := f.as(t, "GET", path, "", member)
	var out domain.APIResponse[[]string]
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || strings.Join(out.Data, ",") != "DATABASE_URL,NEXT_PUBLIC_STRIPE_KEY" {
		t.Fatalf("build args → %d %s", rec.Code, rec.Body.String())
	}
	boat := "boat"
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", RepoFullName: "dwit/api", OnCINotify: "deploy", BuildContext: &boat,
	}); err != nil {
		t.Fatal(err)
	}
	rec = f.as(t, "GET", path, "", member)
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || strings.Join(out.Data, ",") != "ONLY_IN_BOAT" {
		t.Fatalf("con carpeta → %d %s", rec.Code, rec.Body.String())
	}
}

// Los commits que se pueden desplegar son los de la rama del servicio, y los
// da la App: no hace falta un token de GitHub en la máquina de quien mira.
// Mutantes: no pasar la rama (salen los de la por defecto); quedarse con el
// nombre de git habiendo usuario de GitHub; el mensaje entero.
func TestTheCommitsAreTheServiceBranchOnes(t *testing.T) {
	f := hostBuildSetup(t, "record")
	member := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	path := "/api/v1/servers/srv-1/deployables/" + f.d.ID + "/commits"
	rec := f.as(t, "GET", path, "", member)
	var out domain.APIResponse[[]service.RepoCommit]
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || len(out.Data) != 2 {
		t.Fatalf("commits de main → %d %s", rec.Code, rec.Body.String())
	}
	if c := out.Data[0]; c.Sha != shaNew || c.Message != "fix: el login" || c.Author != "ana" || c.Date != "2026-10-19T10:00:00Z" {
		t.Fatalf("primer commit: %+v", c)
	}
	if c := out.Data[1]; c.Author != "Sin Cuenta" {
		t.Fatalf("sin usuario de GitHub, el nombre de git: %+v", c)
	}

	dev := "dev"
	if _, err := f.deploys.UpdateDeployable(f.d, domain.UpdateDeployableRequest{
		Name: "api", RepoFullName: "dwit/api", OnCINotify: "record", Branch: &dev,
	}); err != nil {
		t.Fatal(err)
	}
	rec = f.as(t, "GET", path, "", member)
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || len(out.Data) != 1 || out.Data[0].Message != "en dev" {
		t.Fatalf("commits de dev → %d %s", rec.Code, rec.Body.String())
	}

	other := domain.OrgMembershipClaim{OrgID: "org-2", Role: domain.OrgRoleMember}
	if rec := f.as(t, "GET", path, "", other); rec.Code == 200 {
		t.Fatalf("otra org ve los commits → %d", rec.Code)
	}
}

// Construir en el servidor necesita el sha entero, pero quien despliega
// escribe el corto: el handler se lo pregunta a GitHub. Uno que no existe se
// sigue rechazando. Mutante: no resolverlo (vuelve el 400 de siempre).
func TestAShortShaIsWidenedToBuild(t *testing.T) {
	f := hostBuildSetup(t, "record")
	member := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	path := "/api/v1/servers/srv-1/deployables/" + f.d.ID + "/deploy"
	rec := f.as(t, "POST", path, `{"sha":"`+shaNew[:7]+`"}`, member)
	var out domain.APIResponse[domain.Deployment]
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 202 || out.Data.BuildSha != shaNew {
		t.Fatalf("sha corto → %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.as(t, "POST", path, `{"sha":"fffffff"}`, member); rec.Code != 400 || !strings.Contains(rec.Body.String(), "build-needs-full-sha") {
		t.Fatalf("un sha que no existe → %d %s", rec.Code, rec.Body.String())
	}
}

// Un commit apuntado (aquí, un push en modo `record`) se anuncia a la org,
// para que la lista de commits que haya en pantalla no se quede vieja. Un
// push de otra rama no se apunta, y tampoco se anuncia. Mutantes: no
// publicar; publicar antes de mirar la rama.
func TestARecordedCommitIsAnnounced(t *testing.T) {
	f := hostBuildSetup(t, "record")
	hub := events.NewHub()
	svc := service.NewDeployService(repository.NewDeployRepository(f.db), repository.NewServerRepository(f.db), hub)
	oye, cerrar := hub.Subscribe("u-1", []string{"org-1"})
	defer cerrar()

	if _, err := svc.Notice(f.d, domain.DeployNotice{Sha: shaOld, Ref: "refs/heads/staging"}, domain.BuildSourceHost); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-oye:
		t.Fatalf("un push de otra rama se anunció: %s", e.Type)
	case <-time.After(150 * time.Millisecond):
	}

	if _, err := svc.Notice(f.d, domain.DeployNotice{Sha: shaNew, Ref: "refs/heads/main"}, domain.BuildSourceHost); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-oye:
		b, _ := e.Data.(*domain.ImageBuild)
		if e.Type != "deploy:build" || b == nil || b.DeployableID != f.d.ID || b.Sha != shaNew {
			t.Fatalf("el anuncio: %s %+v", e.Type, e.Data)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("un commit apuntado no se anunció")
	}
}
