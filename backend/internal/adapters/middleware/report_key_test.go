package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
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

// resolver stands in for the repository. Ya sólo hay un tipo de clave: la de un
// proyecto que vive en un servidor. Hubo un segundo —la que viajaba dentro del
// widget del navegador— y se retiró con él el 11-sep-2026.
func resolver(key string) (*domain.ReportProject, error) {
	if key == "srv-key" {
		return &domain.ReportProject{BaseModel: domain.BaseModel{ID: "proj-1"}, Name: "portento", Slug: "portento", OrgID: "org-1"}, nil
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
		// Cleaning up after itself. Ownership is enforced in the service, not
		// here — the middleware only decides which doors exist.
		{http.MethodPatch, "/api/v1/reports/abc/comments/xyz"},
		{http.MethodDelete, "/api/v1/reports/abc/comments/xyz"},
		{http.MethodDelete, "/api/v1/reports/abc/images/xyz"},
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

// The key is scoped to reports. Reaching tasks, notes or token minting with it
// would turn a tenant's credential into an account.
func TestProjectKeyReachesNothingButReports(t *testing.T) {
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/tasks/abc"},
		{http.MethodGet, "/api/v1/notes/"},
		{http.MethodPost, "/api/v1/auth/tokens"},
		{http.MethodGet, "/api/v1/users/"},
		{http.MethodPost, "/api/v1/report-projects/"},
		// Removing a whole report is the tenant discarding a user's report, not
		// tidying its own reply.
		{http.MethodDelete, "/api/v1/reports/abc"},
		// A space's chat is the team talking among themselves — the one place in
		// cac with no visibility column, because nothing in it is ever meant to
		// leave. A tenant's credential reading it would be the leak the missing
		// column exists to prevent.
		{http.MethodGet, "/api/v1/task-spaces/abc/chat"},
		{http.MethodPost, "/api/v1/task-spaces/abc/chat"},
		{http.MethodPatch, "/api/v1/task-spaces/abc/chat/xyz"},
		{http.MethodDelete, "/api/v1/task-spaces/abc/chat/xyz"},
		{http.MethodPost, "/api/v1/task-spaces/abc/chat/attachments"},
		{http.MethodGet, "/api/v1/chat/unread"},
		// And a private conversation between two people is further outside a
		// tenant's reach than anything else here.
		{http.MethodGet, "/api/v1/dm/"},
		{http.MethodPost, "/api/v1/dm/open"},
		{http.MethodGet, "/api/v1/dm/abc/messages"},
		{http.MethodPost, "/api/v1/dm/abc/messages"},
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

// The refusals must say which one happened; "Unauthorized" for both is how an
// integrator spends an afternoon on a key that was simply the wrong kind.
func TestRefusalsAreDistinguishable(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range []struct{ key, path string }{
		{"nope", "/api/v1/reports/"},
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

// Toda clave de proyecto es de servidor, y no puede volver a haber una segunda
// clase.
//
// El fallo que esto vigila no se parece a los demás: no es una rama mal escrita
// sino **un campo que vuelve**. Si `ReportProject` recupera un `Platform` o unos
// `AllowedOrigins`, al principio no lo lee nadie y ninguna prueba de
// comportamiento se entera; la asimetría sólo reaparece cuando alguien, meses
// después, escribe el `if` que los consulta. Para entonces el porqué se perdió.
//
// Lo que había: una clave «web» viajaba dentro del widget que el navegador se
// descargaba, así que era pública por diseño, y lo único que la guardaba era una
// lista de orígenes que la comprobación se saltaba entera para cualquier
// petición sin cabecera `Origin` — o sea, para cualquier `curl`. Se aceptaba
// porque esa clave era de sólo escritura. Por eso no podía leer ni clasificar, y
// por eso hacía falta distinguirla.
//
// El widget se retiró el 11-sep-2026 y con él la distinción. Si hiciera falta
// otra vez, lo que hay que recuperar no es el campo: es el candado que lo
// acompañaba.
func TestNoSecondClassOfProjectKeyComesBack(t *testing.T) {
	forma := reflect.TypeOf(domain.ReportProject{})
	for _, prohibido := range []string{"Platform", "AllowedOrigins"} {
		if _, hay := forma.FieldByName(prohibido); hay {
			t.Errorf("ReportProject.%s ha vuelto: una clave de proyecto vuelve a poder ser pública, "+
				"y nada comprueba que no pueda leer", prohibido)
		}
	}
}
