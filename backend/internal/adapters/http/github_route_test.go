package http

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
La GitHub App (R5 del módulo de servidores), montada como en producción.

GitHub manda dos cosas: el navegador de quien instala, de vuelta con un
`state` que le dimos, y webhooks firmados. Lo que se fija aquí es que ninguna
de las dos pueda hacer más de lo que debe: la firma se comprueba sobre los
bytes crudos, una reentrega no comenta dos veces, una instalación no se ata a
la org que uno quiera, y lo que un commit nombra sólo se busca en la org y el
espacio de su repo. Y las líneas que deja son internas: el cliente no lee los
mensajes de commit del equipo.
*/

const ghSecret = "whsec_prueba"

type ghFixture struct {
	db  *gorm.DB
	r   *chi.Mux
	svc *service.GitHubService
}

func githubDB(t *testing.T) (*gorm.DB, func()) {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_github_route"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.TaskSpace{}, &domain.Item{}, &domain.ItemComment{}, &domain.ReportProject{},
		&domain.GitHubInstallation{}, &domain.GitHubRepo{}, &domain.TaskGitLink{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureGitHubIndexes(db); err != nil {
		t.Fatal(err)
	}
	// Con t.Cleanup y no sólo devolviéndola: si la preparación falla a medias,
	// la base desechable no puede quedarse viva y tumbar la siguiente prueba.
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})
	return db, func() {}
}

// Dos orgs, cada una con su espacio y una tarea con el número 12; la org-1
// tiene además un proyecto `acme` con su folio 7. El repo 100 es de la org-1,
// enlazado a su espacio.
func githubSetup(t *testing.T) (*ghFixture, func()) {
	t.Helper()
	db, cleanup := githubDB(t)
	mk := func(v any) {
		if err := db.Create(v).Error; err != nil {
			t.Fatal(err)
		}
	}
	mk(&domain.TaskSpace{BaseModel: domain.BaseModel{ID: "sp-1"}, OrgID: "org-1", Name: "Uno"})
	mk(&domain.TaskSpace{BaseModel: domain.BaseModel{ID: "sp-2"}, OrgID: "org-2", Name: "Dos"})
	mk(&domain.Item{BaseModel: domain.BaseModel{ID: "it-1"}, OrgID: "org-1", SpaceID: "sp-1", ListID: "l-1", Seq: 12, Title: "login"})
	mk(&domain.Item{BaseModel: domain.BaseModel{ID: "it-2"}, OrgID: "org-2", SpaceID: "sp-2", ListID: "l-2", Seq: 12, Title: "ajena"})
	mk(&domain.ReportProject{BaseModel: domain.BaseModel{ID: "pr-1"}, OrgID: "org-1", Name: "Acme", Slug: "acme", IngestKeyHash: []byte{1}})
	mk(&domain.Item{BaseModel: domain.BaseModel{ID: "it-3"}, OrgID: "org-1", SpaceID: "sp-1", ListID: "l-1", ProjectID: "pr-1", Seq: 7, Title: "folio"})
	// Trampas para la resolución: otra tarea 12 en otro espacio de la misma org,
	// y una del cliente con el número 12 en el mismo espacio. `cac#12` no es
	// ninguna de las dos. Sus ids van **antes** que `it-1` a propósito: sin el
	// filtro que las descarta, la consulta las cogería a ellas, y no por suerte
	// del orden a la buena.
	mk(&domain.TaskSpace{BaseModel: domain.BaseModel{ID: "sp-3"}, OrgID: "org-1", Name: "Tres"})
	mk(&domain.Item{BaseModel: domain.BaseModel{ID: "it-0a"}, OrgID: "org-1", SpaceID: "sp-3", ListID: "l-3", Seq: 12, Title: "otro espacio"})
	mk(&domain.Item{BaseModel: domain.BaseModel{ID: "it-0b"}, OrgID: "org-1", SpaceID: "sp-1", ListID: "l-1", ProjectID: "pr-1", Seq: 12, Title: "acme-12"})

	svc := service.NewGitHubService(repository.NewGitHubRepository(db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, events.NewHub())
	r := chi.NewRouter()
	InitGitHubRoutes(db, r, events.NewHub(), service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret})
	f := &ghFixture{db: db, r: r, svc: svc}

	f.hook(t, "installation", "d-inst", `{"action":"created","installation":{"id":5,"account":{"login":"dwit"}},
		"repositories":[{"id":100,"full_name":"dwit/api"},{"id":200,"full_name":"dwit/web"}]}`)
	if err := repository.NewGitHubRepository(db).BindInstallation(5, "org-1"); err != nil {
		t.Fatal(err)
	}
	db.Model(&domain.GitHubRepo{}).Where("repo_id = 100").Update("space_id", "sp-1")
	return f, cleanup
}

func sign(body string) string {
	mac := hmac.New(sha256.New, []byte(ghSecret))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func (f *ghFixture) send(event, delivery, body, signature string) int {
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(body))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", delivery)
	if signature != "" {
		req.Header.Set("X-Hub-Signature-256", signature)
	}
	rec := httptest.NewRecorder()
	f.r.ServeHTTP(rec, req)
	return rec.Code
}

func (f *ghFixture) hook(t *testing.T, event, delivery, body string) {
	t.Helper()
	if code := f.send(event, delivery, body, sign(body)); code != http.StatusNoContent {
		t.Fatalf("%s %s → %d", event, delivery, code)
	}
}

func (f *ghFixture) comments(itemID string) []domain.ItemComment {
	var out []domain.ItemComment
	f.db.Where("item_id = ?", itemID).Order("created_at").Find(&out)
	return out
}

func push(repoID int, sha, msg string) string {
	return fmt.Sprintf(`{"repository":{"id":%d,"full_name":"dwit/api"},"commits":[{"id":%q,"message":%q,
		"url":"https://github.com/dwit/api/commit/%s","author":{"name":"Ana","username":"ana"}}]}`, repoID, sha, msg, sha)
}

const sha1 = "abc1234def5678abc1234def5678abc1234def56"

// La firma es sobre los bytes que llegaron. Sin cabecera, con otro secreto o
// con un solo byte cambiado: 401, y no se escribe nada.
func TestTheWebhookSignatureIsCheckedOnTheRawBytes(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	body := push(100, sha1, "fix cac#12")
	otro := hmac.New(sha256.New, []byte("otro"))
	otro.Write([]byte(body))
	for name, sig := range map[string]string{
		"sin cabecera":     "",
		"otro secreto":     "sha256=" + hex.EncodeToString(otro.Sum(nil)),
		"un byte cambiado": sign(strings.Replace(body, "cac#12", "cac#13", 1)),
		"sin prefijo":      strings.TrimPrefix(sign(body), "sha256="),
	} {
		if code := f.send("push", "d-"+name, body, sig); code != http.StatusUnauthorized {
			t.Errorf("%s → %d, se esperaba 401", name, code)
		}
	}
	if n := len(f.comments("it-1")); n != 0 {
		t.Errorf("una entrega sin firma buena dejó %d comentarios", n)
	}
	f.hook(t, "push", "d-ok", body)
	if n := len(f.comments("it-1")); n != 1 {
		t.Errorf("la entrega firmada dejó %d comentarios, se esperaba 1", n)
	}
}

// Un commit que nombra una tarea deja una línea en ella: interna, de sistema,
// con el sha y el enlace. Y sólo en la de su org: la tarea 12 de la otra org
// no se entera.
func TestACommitCommentsOnTheTaskItNamesAndOnlyThatOne(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", push(100, sha1, "fix: el login (cac#12)\n\ncuerpo largo"))
	got := f.comments("it-1")
	if len(got) != 1 {
		t.Fatalf("%d comentarios en la tarea nombrada, se esperaba 1", len(got))
	}
	c := got[0]
	if c.Kind != domain.CommentKindSystem || c.Visibility != domain.VisibilityInternal {
		t.Errorf("la línea es %s/%s, se esperaba system/internal", c.Kind, c.Visibility)
	}
	if !strings.Contains(c.Body, "`abc1234`") || !strings.Contains(c.Body, "https://github.com/dwit/api/commit/"+sha1) {
		t.Errorf("la línea no lleva el sha y el enlace: %q", c.Body)
	}
	if strings.Contains(c.Body, "cuerpo largo") {
		t.Errorf("la línea lleva el cuerpo del commit, sólo va la primera: %q", c.Body)
	}
	for id, what := range map[string]string{"it-2": "de otra org", "it-0a": "de otro espacio", "it-0b": "del cliente con el mismo número"} {
		if n := len(f.comments(id)); n != 0 {
			t.Errorf("la tarea 12 %s recibió %d comentarios", what, n)
		}
	}
}

// Un enlace que no es de GitHub no se pinta, y un push enorme no deja cien
// líneas: se leen los primeros veinte commits.
func TestAPushIsBoundedAndOnlyLinksToGitHub(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", strings.Replace(push(100, sha1, "cac#12"),
		"https://github.com/dwit/api/commit/"+sha1, "javascript:alert(1)", 1))
	if got := f.comments("it-1"); len(got) != 1 || strings.Contains(got[0].Body, "javascript:") {
		t.Fatalf("la línea lleva un enlace que no es de GitHub: %+v", got)
	}
	var commits []string
	for i := 0; i < 30; i++ {
		commits = append(commits, fmt.Sprintf(`{"id":"%040d","message":"cac#12","url":"https://github.com/dwit/api/commit/x","author":{"username":"ana"}}`, i+1))
	}
	f.hook(t, "push", "d-2", `{"repository":{"id":100},"commits":[`+strings.Join(commits, ",")+`]}`)
	if n := len(f.comments("it-1")); n != 1+20 {
		t.Errorf("%d líneas tras un push de 30 commits, se esperaban 21", n)
	}
}

// Con un folio, la tarea del proyecto del cliente. Visible para él o no, la
// línea es interna.
func TestAFolioReachesTheClientTaskButStaysInternal(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", push(100, sha1, "arregla acme-7"))
	got := f.comments("it-3")
	if len(got) != 1 || got[0].Visibility != domain.VisibilityInternal {
		t.Fatalf("el folio dejó %+v, se esperaba una línea interna", got)
	}
}

// Una reentrega (mismo id) no hace nada, y el mismo commit en otro push
// (un merge, un cherry-pick a otra rama) tampoco comenta otra vez.
func TestTheSameCommitCommentsOnce(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	body := push(100, sha1, "cac#12")
	f.hook(t, "push", "d-1", body)
	f.hook(t, "push", "d-1", body)
	f.hook(t, "push", "d-2", body)
	if n := len(f.comments("it-1")); n != 1 {
		t.Errorf("%d comentarios del mismo commit, se esperaba 1", n)
	}
}

// Un repo sin enlazar no comenta nada; `#12` a secas tampoco, hasta que el repo
// lo pide.
func TestOnlyALinkedRepoCommentsAndBareRefsAreOptIn(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", push(200, sha1, "cac#12 y acme-7"))
	f.hook(t, "push", "d-2", push(100, "1111111111111111111111111111111111111111", "closes #12"))
	if n := len(f.comments("it-1")) + len(f.comments("it-3")); n != 0 {
		t.Fatalf("%d comentarios sin enlace o con #12 a secas", n)
	}
	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 100").Update("bare_refs", true)
	f.hook(t, "push", "d-3", push(100, "2222222222222222222222222222222222222222", "closes #12"))
	if n := len(f.comments("it-1")); n != 1 {
		t.Errorf("con #12 encendido, %d comentarios; se esperaba 1", n)
	}
}

// Una PR cuenta al abrirse, al fusionarse y al cerrarse sin fusionar; lo demás
// (etiquetas, ediciones) no.
func TestAPullRequestTellsOpenedAndMerged(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	pr := func(action string, merged bool) string {
		return fmt.Sprintf(`{"action":%q,"number":3,"repository":{"id":100},"pull_request":{"title":"login cac#12",
			"body":"","html_url":"https://github.com/dwit/api/pull/3","merged":%v,"user":{"login":"ana"}}}`, action, merged)
	}
	f.hook(t, "pull_request", "d-1", pr("opened", false))
	f.hook(t, "pull_request", "d-2", pr("labeled", false))
	f.hook(t, "pull_request", "d-3", pr("closed", true))
	got := f.comments("it-1")
	if len(got) != 2 {
		t.Fatalf("%d líneas de la PR, se esperaban 2 (abierta y fusionada)", len(got))
	}
	if !strings.Contains(got[0].Body, "PR #3 opened") || !strings.Contains(got[1].Body, "PR #3 merged") {
		t.Errorf("las líneas no dicen lo que pasó: %q / %q", got[0].Body, got[1].Body)
	}
}

// El `state` lleva la org y va firmado: sin él, o con uno caducado o de otro
// servidor, no se ata nada. Y una instalación atada a una org no se la queda
// otra.
func TestAnInstallationIsBoundOnlyWithItsStateAndOnlyOnce(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	setup := func(id int, state string) int {
		req := httptest.NewRequest(http.MethodGet,
			fmt.Sprintf("/webhooks/github/setup?installation_id=%d&setup_action=install&state=%s", id, url.QueryEscape(state)), nil)
		rec := httptest.NewRecorder()
		f.r.ServeHTTP(rec, req)
		return rec.Code
	}
	stateFor := func(orgID string) string {
		u, err := f.svc.LinkURL(orgID)
		if err != nil {
			t.Fatal(err)
		}
		parsed, _ := url.Parse(u)
		return parsed.Query().Get("state")
	}
	org := func(id int64) string {
		var inst domain.GitHubInstallation
		f.db.First(&inst, "installation_id = ?", id)
		return inst.OrgID
	}

	if code := setup(9, ""); code != http.StatusBadRequest {
		t.Errorf("sin state → %d", code)
	}
	bueno := stateFor("org-2")
	// La org-1 en el sitio de la org-2, con la firma de la org-2.
	falso := base64.RawURLEncoding.EncodeToString([]byte("org-1")) + bueno[strings.Index(bueno, "."):]
	if code := setup(9, falso); code != http.StatusBadRequest {
		t.Errorf("con la org cambiada → %d", code)
	}
	if org(9) != "" {
		t.Fatalf("una instalación quedó atada sin un state bueno: %q", org(9))
	}
	if code := setup(9, bueno); code != http.StatusOK {
		t.Fatalf("con su state → %d", code)
	}
	if org(9) != "org-2" {
		t.Errorf("la instalación quedó en %q, se esperaba org-2", org(9))
	}
	// La 5 ya es de la org-1: un state bueno de la org-2 no se la lleva.
	if code := setup(5, stateFor("org-2")); code != http.StatusConflict {
		t.Errorf("atar a otra org una instalación ya atada → %d, se esperaba 409", code)
	}
	if org(5) != "org-1" {
		t.Errorf("la instalación 5 cambió de org: %q", org(5))
	}
}

// Sin la App configurada, todo lo de GitHub contesta 503.
func TestWithoutTheAppGitHubIsA503(t *testing.T) {
	db, cleanup := githubDB(t)
	defer cleanup()
	r := chi.NewRouter()
	InitGitHubRoutes(db, r, events.NewHub(), service.GitHubConfig{})
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("webhook sin App → %d, se esperaba 503", rec.Code)
	}
}

// El slug de un folio sólo se busca entre los proyectos de la org del repo: el
// `otra-7` de otra org no recibe nada.
func TestAFolioOfAnotherOrgIsNotResolved(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.db.Create(&domain.ReportProject{BaseModel: domain.BaseModel{ID: "pr-2"}, OrgID: "org-2", Name: "Otra", Slug: "otra", IngestKeyHash: []byte{2}})
	f.db.Create(&domain.Item{BaseModel: domain.BaseModel{ID: "it-4"}, OrgID: "org-2", SpaceID: "sp-2", ListID: "l-2", ProjectID: "pr-2", Seq: 7, Title: "ajena"})
	f.hook(t, "push", "d-1", push(100, sha1, "toca otra-7"))
	if n := len(f.comments("it-4")); n != 0 {
		t.Errorf("el folio de otra org recibió %d comentarios", n)
	}
}

// Quién toca qué: ver, cualquiera de la org; instalar y enlazar, un admin; un
// repo no se enlaza a un espacio de otra org; y quien no es de la org no ve
// nada (404).
func TestWhoMayLinkGitHub(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	call := func(method, path, body string, orgs ...domain.OrgMembershipClaim) *httptest.ResponseRecorder {
		pair, err := repository.GenerateTokens("u-1", "ana", false, orgs)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		f.r.ServeHTTP(rec, req)
		return rec
	}
	viewer := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleViewer}
	admin := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleAdmin}
	var repoID string
	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 200").Pluck("id", &repoID)
	patch := "/api/v1/organizations/org-1/github/repos/" + repoID

	if rec := call(http.MethodGet, "/api/v1/organizations/org-1/github/", "", viewer); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), "dwit/web") {
		t.Errorf("un viewer viendo → %d %s", rec.Code, rec.Body.String())
	}
	if rec := call(http.MethodGet, "/api/v1/organizations/org-1/github/", "",
		domain.OrgMembershipClaim{OrgID: "org-2", Role: domain.OrgRoleAdmin}); rec.Code != http.StatusNotFound {
		t.Errorf("alguien de otra org viendo → %d, se esperaba 404", rec.Code)
	}
	if rec := call(http.MethodPost, "/api/v1/organizations/org-1/github/link", "{}", viewer); rec.Code != http.StatusForbidden {
		t.Errorf("un viewer pidiendo el enlace → %d, se esperaba 403", rec.Code)
	}
	if rec := call(http.MethodPost, "/api/v1/organizations/org-1/github/link", "{}", admin); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), "github.com/apps/cac-test/installations/new?state=") {
		t.Errorf("un admin pidiendo el enlace → %d %s", rec.Code, rec.Body.String())
	}
	if rec := call(http.MethodPatch, patch, `{"spaceId":"sp-1"}`, viewer); rec.Code != http.StatusForbidden {
		t.Errorf("un viewer enlazando → %d, se esperaba 403", rec.Code)
	}
	if rec := call(http.MethodPatch, patch, `{"spaceId":"sp-2"}`, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("enlazar a un espacio de otra org → %d, se esperaba 400", rec.Code)
	}
	if rec := call(http.MethodPatch, patch, `{"spaceId":"sp-1","bareRefs":true}`, admin); rec.Code != http.StatusOK {
		t.Errorf("un admin enlazando → %d %s", rec.Code, rec.Body.String())
	}
	var repo domain.GitHubRepo
	f.db.First(&repo, "repo_id = 200")
	if repo.SpaceID != "sp-1" || !repo.BareRefs {
		t.Errorf("el enlace no quedó: %+v", repo)
	}
}

// Un state caducado no ata nada, aunque su firma sea buena.
func TestAnExpiredLinkStateBindsNothing(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	u, _ := f.svc.LinkURL("org-2")
	parsed, _ := url.Parse(u)
	state := parsed.Query().Get("state")
	later := service.NewGitHubServiceAt(repository.NewGitHubRepository(f.db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, func() time.Time { return time.Now().Add(11 * time.Minute) })
	if err := later.Setup(9, state); err == nil {
		t.Error("un state de hace once minutos ató la instalación")
	}
}
