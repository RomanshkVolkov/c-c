package http

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Las PRs que no llegan por un evento: las que ya estaban abiertas cuando se
vinculó el repo, y la que alguien pega a mano en la tarea. Contra un GitHub
falso que sólo sabe dar un token y listar o enseñar PRs, y que apunta lo que le
piden.
*/

type prGitHub struct {
	mu    sync.Mutex
	calls []string
	prs   map[string]any // ruta → respuesta
}

func (g *prGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, r.Method+" "+r.URL.RequestURI())
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/access_tokens") {
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "t", "expires_at": time.Now().Add(time.Hour)})
		return
	}
	if out, ok := g.prs[r.URL.Path]; ok {
		_ = json.NewEncoder(w).Encode(out)
		return
	}
	w.WriteHeader(http.StatusNotFound)
}

func pr(n int, title, head, state string, draft bool) map[string]any {
	return map[string]any{
		"number": n, "title": title, "body": "", "state": state, "draft": draft,
		"html_url":   "https://github.com/dwit/web/pull/" + itoa(n),
		"created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-02T10:00:00Z",
		"user": map[string]any{"login": "ana"},
		"head": map[string]any{"ref": head, "sha": "abc"}, "base": map[string]any{"ref": "main"},
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func backfillSetup(t *testing.T) (*ghFixture, *prGitHub, *service.GitHubService, func()) {
	t.Helper()
	f, cleanup := githubSetup(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &prGitHub{prs: map[string]any{
		"/repos/dwit/web/pulls": []any{
			pr(3, "login nuevo", "cac-12-login", "open", true),
			pr(4, "nada que ver", "arreglos", "open", false),
		},
		"/repos/dwit/web/pulls/9": pr(9, "sin nombrar la tarea", "arreglos", "open", false),
	}}
	api := httptest.NewServer(fake)
	gh := service.NewGitHubService(repository.NewGitHubRepository(f.db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, events.NewHub()).
		WithApp(service.GitHubAppKey{AppID: appID, Key: key, APIURL: api.URL}).Sync()
	r := chi.NewRouter()
	InitGitHubRoutesWith(r, gh)
	f.r = r
	return f, fake, gh, func() { api.Close(); cleanup() }
}

func (f *ghFixture) as(t *testing.T, method, path, body string, orgs ...domain.OrgMembershipClaim) *httptest.ResponseRecorder {
	t.Helper()
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

// Vincular un repo a un espacio trae sus PRs abiertas, como si acabaran de
// abrirse: la de la rama `cac-12-…` queda en la tarea 12, con su estado y una
// sola línea; la que no nombra nada, en ninguna.
func TestLinkingARepoBringsItsOpenPRs(t *testing.T) {
	f, fake, _, cleanup := backfillSetup(t)
	defer cleanup()
	var repoID string
	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 200").Pluck("id", &repoID)
	admin := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleAdmin}
	if rec := f.as(t, http.MethodPatch, "/api/v1/organizations/org-1/github/repos/"+repoID, `{"spaceId":"sp-1"}`, admin); rec.Code != http.StatusOK {
		t.Fatalf("vincular → %d %s", rec.Code, rec.Body.String())
	}
	prs := f.links("it-1", domain.GitLinkPR)
	if len(prs) != 1 || prs[0].Key != "3" || prs[0].State != domain.PRStateDraft || prs[0].Via != domain.GitViaBranch {
		t.Fatalf("enlaces de la tarea 12: %+v", prs)
	}
	if n := len(f.comments("it-1")); n != 1 {
		t.Fatalf("líneas en el hilo: %d", n)
	}
	if !strings.Contains(strings.Join(fake.calls, " "), "/repos/dwit/web/pulls?state=open") {
		t.Fatalf("no pidió las abiertas: %v", fake.calls)
	}
	// Volver a guardar lo mismo no vuelve a pedir nada.
	antes := len(fake.calls)
	f.as(t, http.MethodPatch, "/api/v1/organizations/org-1/github/repos/"+repoID, `{"spaceId":"sp-1"}`, admin)
	if len(fake.calls) != antes {
		t.Fatalf("revinculó sin cambios: %v", fake.calls[antes:])
	}
}

// Pegar la URL de una PR en una tarea la enlaza aunque no nombre la tarea, y
// sólo si el repo es de la org de la tarea.
func TestAPastedPRLinksToTheTask(t *testing.T) {
	f, _, _, cleanup := backfillSetup(t)
	defer cleanup()
	member := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	post := func(body string, orgs ...domain.OrgMembershipClaim) *httptest.ResponseRecorder {
		return f.as(t, http.MethodPost, "/api/v1/tasks/it-1/git/prs", body, orgs...)
	}
	if rec := post(`{"url":"https://github.com/dwit/web/pull/9/files"}`, member); rec.Code != http.StatusOK {
		t.Fatalf("pegar → %d %s", rec.Code, rec.Body.String())
	}
	prs := f.links("it-1", domain.GitLinkPR)
	if len(prs) != 1 || prs[0].Key != "9" || prs[0].Via != domain.GitViaManual || prs[0].RepoFullName != "dwit/web" {
		t.Fatalf("enlace: %+v", prs)
	}
	cases := []struct {
		name, body string
		orgs       []domain.OrgMembershipClaim
		code       int
	}{
		{"no es una PR", `{"url":"https://github.com/dwit/web/issues/9"}`, []domain.OrgMembershipClaim{member}, http.StatusBadRequest},
		{"no es de GitHub", `{"url":"https://gitlab.com/dwit/web/pull/9"}`, []domain.OrgMembershipClaim{member}, http.StatusBadRequest},
		{"repo de fuera", `{"url":"https://github.com/otro/repo/pull/1"}`, []domain.OrgMembershipClaim{member}, http.StatusUnprocessableEntity},
		{"PR que no existe", `{"url":"https://github.com/dwit/web/pull/77"}`, []domain.OrgMembershipClaim{member}, http.StatusBadGateway},
		{"un lector", `{"url":"https://github.com/dwit/web/pull/9"}`, []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleViewer}}, http.StatusForbidden},
		{"otra org", `{"url":"https://github.com/dwit/web/pull/9"}`, []domain.OrgMembershipClaim{{OrgID: "org-2", Role: domain.OrgRoleAdmin}}, http.StatusNotFound},
	}
	for _, c := range cases {
		if rec := post(c.body, c.orgs...); rec.Code != c.code {
			t.Errorf("%s → %d %s (se esperaba %d)", c.name, rec.Code, rec.Body.String(), c.code)
		}
	}
}
