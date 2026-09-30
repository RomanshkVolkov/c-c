package http

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/swarm-manage/internal/adapters/handler"
	"github.com/guz-studio/cac/swarm-manage/internal/adapters/middleware"
	"github.com/guz-studio/cac/swarm-manage/internal/core/config"
	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
	"github.com/guz-studio/cac/swarm-manage/internal/core/service"
)

func InitRoutes(cfg config.Config) *chi.Mux {
	docker := repository.NewDockerClient()
	svc := service.NewSwarmService(docker)
	return buildRouter(cfg, handler.NewSwarmHandler(svc))
}

// buildRouter, aparte para poder recorrer las rutas en las pruebas sin un
// socket de Docker detrás.
func buildRouter(cfg config.Config, h *handler.SwarmHandler) *chi.Mux {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recovery)
	r.Use(middleware.CORS)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"healthy","agent":"swarm-manage"}`)
	})

	// Todo lo de /api/v1 exige un pase de la app. /health se queda abierto:
	// dice que hay alguien escuchando y nada más.
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(middleware.RequireSession(cfg.SessionKey, cfg.ServerID))
		r.Get("/stacks", h.ListStacks)
		r.Get("/stacks/{stack}/services", h.ListServices)
		r.Get("/services", h.ListServices)
		r.Get("/nodes", h.ListNodes)
		r.Get("/services/{id}/logs", h.StreamServiceLogs)
		r.Post("/services/{id}/force-update", h.ForceUpdateService)
		r.Get("/stats", h.NodeStats)
	})

	return r
}
