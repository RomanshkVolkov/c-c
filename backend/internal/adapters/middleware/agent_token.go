package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// AgentResolver convierte un token de agente en el servidor al que pertenece.
// Se inyecta al montar las rutas para que este paquete no tenga base de datos.
type AgentResolver func(plain string) (*domain.Server, error)

// AgentTokenMiddleware autentica al agente de un servidor: `Authorization:
// Bearer cac_agent_…`. Lo que queda en el contexto es **el servidor**, no una
// persona: el agente no es nadie, y todo lo que pida se contesta sólo sobre su
// propia máquina (ver `handler.AgentServer`).
//
// Un token que no empieza por el prefijo no llega a la base: un JWT o un PAT
// mandados aquí por error se rechazan sin consultar nada.
func AgentTokenMiddleware(resolve AgentResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			plain := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !strings.HasPrefix(plain, repository.AgentTokenPrefix) {
				handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-agent-token")
				return
			}
			server, err := resolve(plain)
			if err != nil || server == nil || server.ID == "" {
				handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-agent-token")
				return
			}
			ctx := context.WithValue(r.Context(), repository.AgentServerContextKey, server)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
