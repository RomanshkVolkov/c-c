package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Un token que no es de agente se rechaza **sin preguntarle a la base**.
//
// Un JWT o un PAT mandados a `/agent/v1` por error acabarían en 401 igual —no
// casan con ningún hash—, pero cada uno costaría una consulta, y un cliente
// mal configurado que reintenta en bucle sería una consulta por intento contra
// una ruta que no pide login.
func TestANonAgentTokenNeverReachesTheResolver(t *testing.T) {
	llamadas := 0
	resolve := func(string) (*domain.Server, error) {
		llamadas++
		return &domain.Server{BaseModel: domain.BaseModel{ID: "srv-1"}}, nil
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := AgentTokenMiddleware(resolve)(next)

	for _, auth := range []string{"", "Bearer eyJhbGciOi.jwt.firma", "Bearer cac_pat_abc", "cac_agent_sin_bearer_es_igual"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/agent/v1/jobs", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		h.ServeHTTP(rec, req)
		if auth == "cac_agent_sin_bearer_es_igual" {
			continue // sin «Bearer » el prefijo casa: se acepta la forma corta
		}
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%q → %d, se esperaba 401", auth, rec.Code)
		}
	}
	if llamadas != 1 {
		t.Errorf("el resolvedor se llamó %d veces; sólo el token con prefijo de agente debía llegar", llamadas)
	}

	// Y con un token de agente que resuelve, pasa con el servidor en el contexto.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/agent/v1/jobs", nil)
	req.Header.Set("Authorization", "Bearer cac_agent_bueno")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("un token de agente bueno → %d", rec.Code)
	}
}
