package http

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/swarm-manage/internal/adapters/handler"
	"github.com/guz-studio/cac/swarm-manage/internal/adapters/middleware"
	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
	"github.com/guz-studio/cac/swarm-manage/internal/core/service"
)

func InitRoutes() *chi.Mux {
	docker := repository.NewDockerClient()
	svc := service.NewSwarmService(docker)
	h := handler.NewSwarmHandler(svc)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recovery)
	r.Use(middleware.CORS)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"healthy","agent":"swarm-manage"}`)
	})

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/stacks", h.ListStacks)
		r.Get("/stacks/{stack}/services", h.ListServices)
		r.Get("/services", h.ListServices)
		r.Get("/nodes", h.ListNodes)
	})

	return r
}
