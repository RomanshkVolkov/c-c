package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// stubCalls contesta 200 a todo: si una petición sin JWT llega hasta aquí, la
// ruta está abierta.
type stubCalls struct{}

func ok(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }

func (stubCalls) Create(w http.ResponseWriter, r *http.Request)          { ok(w, r) }
func (stubCalls) List(w http.ResponseWriter, r *http.Request)            { ok(w, r) }
func (stubCalls) Get(w http.ResponseWriter, r *http.Request)             { ok(w, r) }
func (stubCalls) Revoke(w http.ResponseWriter, r *http.Request)          { ok(w, r) }
func (stubCalls) Token(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func (stubCalls) Kick(w http.ResponseWriter, r *http.Request)            { ok(w, r) }
func (stubCalls) RecordingPolicy(w http.ResponseWriter, r *http.Request) { ok(w, r) }
func (stubCalls) StartRecording(w http.ResponseWriter, r *http.Request)  { ok(w, r) }
func (stubCalls) PublicInspect(w http.ResponseWriter, r *http.Request)   { ok(w, r) }
func (stubCalls) PublicJoin(w http.ResponseWriter, r *http.Request)      { ok(w, r) }

// Sólo las dos rutas públicas entran sin JWT. Todas las demás, 401.
//
// Recorre el enrutado de verdad (`mountCallRoutes`) con `chi.Walk`, igual que
// `TestNoAgentRouteWithoutAuth` en el agente: una ruta nueva que se monte sin
// el middleware falla aquí sin que nadie tenga que acordarse de añadirla.
//
// El mutante que mata: quitar `AuthMiddleware` del grupo de `/call-invites`, o
// colgar una ruta de miembros fuera del grupo.
func TestOnlyThePublicCallRoutesSkipAuth(t *testing.T) {
	r := chi.NewRouter()
	mountCallRoutes(r, stubCalls{})

	public := map[string]bool{
		"POST /api/v1/public/calls/inspect": true,
		"POST /api/v1/public/calls/join":    true,
	}
	seen, open := 0, 0
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen++
		path := strings.NewReplacer("{id}", "x", "{identity}", "guest:x").Replace(route)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		key := method + " " + strings.TrimSuffix(route, "/")
		if public[key] {
			open++
			if rec.Code == http.StatusUnauthorized {
				t.Errorf("%s pide JWT y es la puerta de quien no tiene cuenta", key)
			}
			return nil
		}
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s sin JWT → %d, se esperaba 401", key, rec.Code)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen < 10 || open != len(public) {
		t.Fatalf("el recorrido vio %d rutas y %d públicas: no está mirando el enrutado entero", seen, open)
	}
}
