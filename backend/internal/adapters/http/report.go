package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitReportRoutes(db *gorm.DB, r *chi.Mux) {
	projectRepo := repository.NewReportProjectRepository(db)
	projectSvc := service.NewReportProjectService(projectRepo)
	projects := handler.NewReportProjectHandler(projectSvc)

	// Admin API — JWT, org-scoped.
	r.Route("/api/v1/report-projects", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", projects.List)
		r.Post("/", projects.Create)
		r.Patch("/{id}", projects.Update)
		r.Delete("/{id}", projects.Delete)
		r.Post("/{id}/rotate-key", projects.RotateKey)
	})
}
