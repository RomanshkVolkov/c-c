package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/swarm-manage/internal/core/config"
)

// Ninguna ruta de /api/v1 contesta sin pase.
//
// Recorre el router de verdad con `chi.Walk`, así que una ruta nueva montada
// fuera del grupo —o el grupo sin el middleware— se cae aquí sin que nadie
// tenga que acordarse de añadirla. Es lo que hace posible, más adelante, que
// el agente tenga verbos que cambian cosas: sin esto, `exec` o `deploy` serían
// root para quien sepa la IP.
func TestNoAgentRouteWithoutAuth(t *testing.T) {
	cfg := config.Config{SessionKey: "k", ServerID: "srv-1"}
	r := buildRouter(cfg, nil) // el handler no llega a correr: el middleware corta antes

	vistas := 0
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/v1") {
			return nil
		}
		vistas++
		path := strings.NewReplacer("{id}", "x", "{stack}", "x").Replace(route)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s sin pase → %d, se esperaba 401", method, route, rec.Code)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if vistas < 7 {
		t.Fatalf("el recorrido sólo vio %d rutas de /api/v1: no está mirando el router entero", vistas)
	}
}

// /health se queda abierto, y no dice nada que no diga ya el puerto.
func TestHealthStaysOpen(t *testing.T) {
	r := buildRouter(config.Config{}, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("/health → %d", rec.Code)
	}
}
