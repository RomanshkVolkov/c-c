package http

import (
	"context"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
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

	store, err := mediastore.New(
		context.Background(),
		repository.GetEnv("REPORTS_MEDIA_BUCKET", ""),
		repository.GetEnv("REPORTS_MEDIA_REGION", ""),
		repository.GetEnv("REPORTS_MEDIA_ACCESS_KEY_ID", ""),
		repository.GetEnv("REPORTS_MEDIA_SECRET_ACCESS_KEY", ""),
	)
	if err != nil {
		lg.Error("mediastore init failed: " + err.Error())
	} else if store.Enabled() {
		lg.Info("report image proxy enabled → s3://" + repository.GetEnv("REPORTS_MEDIA_BUCKET", ""))
	} else {
		lg.Warn("REPORTS_MEDIA_BUCKET not set — report image proxy disabled")
	}

	if repository.TelemetryEncryptionEnabled() {
		lg.Info("telemetry encryption enabled (REPORTS_KEK set)")
	} else {
		lg.Warn("REPORTS_KEK not set — report telemetry will not be stored")
	}

	// Hourly purge of telemetry blobs past their TTL (decision 4/7).
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if n, err := reportRepo.PurgeExpiredTelemetry(); err != nil {
				lg.Error("telemetry purge failed: " + err.Error())
			} else if n > 0 {
				lg.Info("purged expired telemetry blobs")
			}
		}
	}()

	hub := events.NewHub()

	projectSvc := service.NewReportProjectService(projectRepo, orgRepo)
	reportSvc := service.NewReportService(reportRepo, orgRepo, authRepo, imgClient, hub)

	projects := handler.NewReportProjectHandler(projectSvc)
	ingest := handler.NewIngestHandler(projectRepo, reportSvc)
	admin := handler.NewReportAdminHandler(reportSvc)
	imageProxy := handler.NewImageProxyHandler(reportRepo, store)
	eventsH := handler.NewEventsHandler(hub)

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

	// Image proxy — its own dual auth (signed URL OR JWT), so it lives OUTSIDE
	// the JWT-only group: the webview's <img> can't send an Authorization header.
	r.Get("/api/v1/reports/{id}/images/{imageId}", imageProxy.Serve)

	// SSE notifications — org-scoped. Auth by ?token= (EventSource can't set
	// headers), so it lives outside the JWT-only group.
	r.Get("/api/v1/events", eventsH.Stream)

	// Public ingest — auth by X-Ingest-Key, per-project CORS/rate limit. No JWT.
	r.Post("/ingest/v1/reports", ingest.CreateReport)
	r.Options("/ingest/v1/reports", ingest.Preflight)

	// Reporter follow-up — auth by the per-report token (?token=). No JWT/email.
	r.Post("/ingest/v1/reports/unread", ingest.UnreadCounts) // batch unread badge
	r.Options("/ingest/v1/reports/unread", ingest.Preflight)
	r.Get("/ingest/v1/reports/{id}", ingest.ReporterView)
	r.Post("/ingest/v1/reports/{id}/comments", ingest.ReporterComment)
	r.Options("/ingest/v1/reports/{id}/comments", ingest.Preflight)
}
