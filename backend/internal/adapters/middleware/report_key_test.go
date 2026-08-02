package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

func keyReq(method, path, key string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	if key != "" {
		r.Header.Set("X-Ingest-Key", key)
	}
	return r
}

// resolver stands in for the repository: "srv-key" is a server-to-server
// project, "web-key" is one whose key ships inside a browser widget.
func resolver(key string) (*domain.ReportProject, error) {
	switch key {
	case "srv-key":
		return &domain.ReportProject{BaseModel: domain.BaseModel{ID: "proj-1"}, Name: "portento", Slug: "portento", Platform: "app", OrgID: "org-1"}, nil
	case "web-key":
		return &domain.ReportProject{BaseModel: domain.BaseModel{ID: "proj-2"}, Name: "boaty", Slug: "boaty", Platform: "web", OrgID: "org-1"}, nil
	}
	return nil, http.ErrNoLocation
}

// run drives the middleware and reports the status plus whether the request
// reached the handler with project-scoped claims.
func run(t *testing.T, r *http.Request) (int, *domain.ClaimsJWT) {
	t.Helper()
	var got *domain.ClaimsJWT
	h := ReportKeyOrAuth(resolver)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = GetUser(r)
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code, got
}

// The whole point: a project drives its own board with the credential it
// already has, and arrives identified as that project.
func TestProjectKeyReadsAndTriagesItsOwnBoard(t *testing.T) {
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/reports/"},
		{http.MethodGet, "/api/v1/reports/abc"},
		{http.MethodGet, "/api/v1/reports/taxonomy"},
		{http.MethodPatch, "/api/v1/reports/abc"},
		{http.MethodPost, "/api/v1/reports/abc/comments"},
		{http.MethodPost, "/api/v1/reports/abc/images"},
	} {
		code, claims := run(t, keyReq(c.method, c.path, "srv-key"))
		if code != http.StatusOK {
			t.Errorf("%s %s → %d, want 200", c.method, c.path, code)
			continue
		}
		if claims == nil || !claims.IsProjectScoped() {
			t.Errorf("%s %s reached the handler without project-scoped claims", c.method, c.path)
			continue
		}
		// The name is what a reply gets signed with; without it the thread shows
		// a comment from nobody.
		if claims.ProjectName == "" {
			t.Errorf("%s %s: claims carry no project name", c.method, c.path)
		}
	}
}

// A project key must never inherit org membership: if it did, the two gates in
// report_admin.go would fall back to it and hand the tenant every project its
// organization owns — the exact privilege this credential avoids.
func TestProjectKeyCarriesNoOrgMembership(t *testing.T) {
	_, claims := run(t, keyReq(http.MethodGet, "/api/v1/reports/", "srv-key"))
	if claims == nil {
		t.Fatal("no claims")
	}
	if len(claims.OrgIDs()) != 0 {
		t.Errorf("OrgIDs() = %v, want empty", claims.OrgIDs())
	}
	if claims.Superadmin {
		t.Error("a project key must never be superadmin")
	}
	if _, member := claims.RoleInOrg("org-1"); member {
		t.Error("a project key must not be a member of its own project's org either")
	}
}

// A "web" project's key is printed inside the widget the browser downloads, and
// the Origin allowlist that guards it is skipped for requests that send no
// Origin header at all (ingest.go) — a curl passes. Write-only that is an
// accepted trade against a rate limit; reading every report is not.
func TestABrowserWidgetKeyCannotReadTheBoard(t *testing.T) {
	code, claims := run(t, keyReq(http.MethodGet, "/api/v1/reports/", "web-key"))
	if code != http.StatusForbidden {
		t.Errorf("GET with a web project's key → %d, want 403", code)
	}
	if claims != nil {
		t.Error("the request reached the handler")
	}
}

// The key is scoped to reports. Reaching tasks, notes or token minting with it
// would turn a tenant's credential into an account.
func TestProjectKeyReachesNothingButReports(t *testing.T) {
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/tasks/abc"},
		{http.MethodGet, "/api/v1/notes/"},
		{http.MethodPost, "/api/v1/auth/tokens"},
		{http.MethodGet, "/api/v1/users/"},
		{http.MethodPost, "/api/v1/report-projects/"},
		// Erasing history. The key adds and reclassifies; it never removes.
		{http.MethodDelete, "/api/v1/reports/abc"},
		{http.MethodPatch, "/api/v1/reports/abc/comments/xyz"},
		{http.MethodDelete, "/api/v1/reports/abc/comments/xyz"},
		{http.MethodDelete, "/api/v1/reports/abc/images/xyz"},
	} {
		code, claims := run(t, keyReq(c.method, c.path, "srv-key"))
		if code != http.StatusForbidden || claims != nil {
			t.Errorf("%s %s → %d (claims=%v), want 403 and no handler", c.method, c.path, code, claims != nil)
		}
	}
}

// A wrong key is rejected, and a request with no key falls through to the
// normal Authorization header path rather than being let in.
func TestUnknownKeyAndNoKey(t *testing.T) {
	if code, _ := run(t, keyReq(http.MethodGet, "/api/v1/reports/", "nope")); code != http.StatusUnauthorized {
		t.Errorf("unknown key → %d, want 401", code)
	}
	code, claims := run(t, keyReq(http.MethodGet, "/api/v1/reports/", ""))
	if code != http.StatusUnauthorized || claims != nil {
		t.Errorf("no key → %d, want 401 from AuthMiddleware", code)
	}
}

// The refusals must say which one happened; "Unauthorized" for all three is how
// an integrator spends an afternoon on a key that was simply the wrong kind.
func TestRefusalsAreDistinguishable(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range []struct{ key, path string }{
		{"nope", "/api/v1/reports/"},
		{"web-key", "/api/v1/reports/"},
		{"srv-key", "/api/v1/notes/"},
	} {
		rec := httptest.NewRecorder()
		ReportKeyOrAuth(resolver)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).
			ServeHTTP(rec, keyReq(http.MethodGet, c.path, c.key))
		var body struct {
			Error string `json:"error"`
		}
		json.Unmarshal(rec.Body.Bytes(), &body)
		if body.Error == "" || seen[body.Error] {
			t.Errorf("key=%s path=%s → error %q, want a distinct code (body %s)",
				c.key, c.path, body.Error, strings.TrimSpace(rec.Body.String()))
		}
		seen[body.Error] = true
	}
}
