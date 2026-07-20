package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitReportRoutes(db *gorm.DB, r *chi.Mux) {
	projectRepo := repository.NewReportProjectRepository(db)
	reportRepo := repository.NewReportRepository(db)
	orgRepo := repository.NewOrganizationRepository(db)

	imgClient := imageservice.New(
		repository.GetEnv("IMAGE_SERVICE_URL", ""),
		repository.GetEnv("IMAGE_SERVICE_CERT_CN", ""),
		repository.GetEnv("IMAGE_SERVICE_API_KEY", ""),
	)
	if imgClient.Enabled() {
		lg.Info("image uploads enabled → " + repository.GetEnv("IMAGE_SERVICE_URL", ""))
	} else {
		lg.Warn("IMAGE_SERVICE_API_KEY not set — report screenshots disabled")
	}

	projectSvc := service.NewReportProjectService(projectRepo)
	reportSvc := service.NewReportService(reportRepo, orgRepo, imgClient)

	projects := handler.NewReportProjectHandler(projectSvc)
	ingest := handler.NewIngestHandler(projectRepo, reportSvc)

	// Admin API — JWT, org-scoped.
	r.Route("/api/v1/report-projects", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", projects.List)
		r.Post("/", projects.Create)
		r.Patch("/{id}", projects.Update)
		r.Delete("/{id}", projects.Delete)
		r.Post("/{id}/rotate-key", projects.RotateKey)
	})

	// Public ingest — auth by X-Ingest-Key, per-project CORS/rate limit. No JWT.
	r.Post("/ingest/v1/reports", ingest.CreateReport)
	r.Options("/ingest/v1/reports", ingest.Preflight)
}
