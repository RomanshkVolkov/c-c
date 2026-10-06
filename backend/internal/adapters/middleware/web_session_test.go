package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una sesión web no llega a lo que es sólo del escritorio, aunque la persona
// pueda desde su app: servidores (con ellos, SSH y pases al agente) y tokens
// personales. El escritorio sigue llegando. Mutante: no mirar `claims.Web`.
func TestAWebSessionCannotReachDesktopOnlyPaths(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "a-test")
	t.Setenv("JWT_SECRET_REFRESH", "r-test")
	h := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	pedir := func(web bool, path string) int {
		tok, err := repository.GenerateTokensFor("u1", "ana", true, nil, web)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}
	for _, p := range []string{"/api/v1/servers/", "/api/v1/servers/s1/agent/session", "/api/v1/auth/tokens"} {
		if code := pedir(true, p); code != http.StatusForbidden {
			t.Errorf("web → %s: %d, se esperaba 403", p, code)
		}
		if code := pedir(false, p); code != http.StatusOK {
			t.Errorf("escritorio → %s: %d", p, code)
		}
	}
	if code := pedir(true, "/api/v1/tasks/mine"); code != http.StatusOK {
		t.Errorf("web → tareas: %d", code)
	}
}
