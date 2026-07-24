package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/k8s"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitServerRoutes(db *gorm.DB, r *chi.Mux) {
	repo := repository.NewServerRepository(db)
	svc := service.NewServerService(repo)
	h := handler.NewServerHandler(svc)

	hub := service.NewK8sHubService(k8s.New())
	k8sH := handler.NewK8sHandler(svc, hub)

	r.Route("/api/v1/servers", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.ListServers)
		r.Post("/", h.CreateServer)
		r.Delete("/{id}", h.DeleteServer)
		// Platform hub (kubernetes servers): read-only cluster views.
		r.Get("/{id}/k8s/routes", k8sH.Routes)
		r.Get("/{id}/k8s/health", k8sH.Health)
	})
}
