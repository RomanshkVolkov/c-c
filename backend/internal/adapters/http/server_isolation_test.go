package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Un servidor no se le enseña a quien no es de su org, por ninguna de sus
// rutas (command-and-control-225). jose lo vio con la app: cambió de org y la
// pantalla de boaty seguía ahí. Eso era de la app, pero jose es superadmin y
// su caso no prueba nada del backend; esto sí: un admin de **otra** org recorre
// todas las rutas de un servidor que no es suyo.
//
// Contesta 404 y no 403: confirmar que el id existe ya sería contar algo.
// Mutantes:
//   - quitarle a `scopeServer` la comprobación de miembro;
//   - colgar una ruta nueva del servidor que no pase por `scopeServer`;
//   - que la lista no filtre por las orgs de quien pregunta.
func TestAnOutsiderSeesNothingOfAServer(t *testing.T) {
	db := backupDB(t)
	r := chi.NewRouter()
	InitServerRoutes(db, r, events.NewHub())

	pair, err := repository.GenerateTokens("u-outsider", "outsider", false,
		[]domain.OrgMembershipClaim{{OrgID: "org-2", Role: domain.OrgRoleAdmin}})
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	seen := 0
	err = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		// El proxy de integraciones no va con JWT: lo abre su propio pase.
		if !strings.HasPrefix(route, "/api/v1/servers/{id}") || strings.Contains(route, "/proxy") {
			return nil
		}
		seen++
		path := strings.NewReplacer("{id}", "srv-1", "{did}", "d", "{depId}", "dep", "{tid}", "t",
			"{rid}", "r", "{bid}", "b", "{iid}", "i").Replace(route)
		if rec := do(method, path, "{}"); rec.Code != http.StatusNotFound {
			t.Errorf("%s %s desde otra org → %d %s, se esperaba 404", method, route, rec.Code, rec.Body.String())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Sin esto, un recorrido que no encontrara las rutas pasaría sin mirar.
	if seen < 40 {
		t.Fatalf("el recorrido vio %d rutas de un servidor", seen)
	}

	rec := do("GET", "/api/v1/servers/", "")
	var list struct{ Data []domain.ServerResponse }
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("la lista → %d %s", rec.Code, rec.Body.String())
	}
	if len(list.Data) != 0 {
		t.Fatalf("la lista de otra org enseña %d servidores", len(list.Data))
	}
}
