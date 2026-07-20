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
	authRepo := repository.NewAuthRepository(db)

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

	projectSvc := service.NewReportProjectService(projectRepo, orgRepo)
	reportSvc := service.NewReportService(reportRepo, orgRepo, authRepo, imgClient)

	projects := handler.NewReportProjectHandler(projectSvc)
	ingest := handler.NewIngestHandler(projectRepo, reportSvc)
	admin := handler.NewReportAdminHandler(reportSvc)

	// Admin API — JWT, org-scoped.
	r.Route("/api/v1/report-projects", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", projects.List)
		r.Post("/", projects.Create)
		r.Patch("/{id}", projects.Update)
		r.Delete("/{id}", projects.Delete)
		r.Post("/{id}/rotate-key", projects.RotateKey)
	})

	// Triage console API — JWT, org-scoped (non-members get 404, anti-IDOR).
	r.Route("/api/v1/reports", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", admin.List)
		r.Get("/transitions", admin.Transitions)
		r.Get("/{id}", admin.Get)
		r.Patch("/{id}", admin.Update)
		r.Post("/{id}/comments", admin.AddComment)
		r.Patch("/{id}/comments/{commentId}", admin.EditComment)
		r.Delete("/{id}/comments/{commentId}", admin.DeleteComment)
		r.Post("/{id}/images", admin.AttachImages)
		r.Delete("/{id}/images/{imageId}", admin.DetachImage)
	})

	// Public ingest — auth by X-Ingest-Key, per-project CORS/rate limit. No JWT.
	r.Post("/ingest/v1/reports", ingest.CreateReport)
	r.Options("/ingest/v1/reports", ingest.Preflight)
}
