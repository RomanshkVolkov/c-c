package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// InitActivityRoutes: la actividad de CI de una org (R9): los runs de GitHub
// Actions de sus repos y sus deploys, mezclados. Ver domain/activity.go.
func InitActivityRoutes(db *gorm.DB, r *chi.Mux) {
	h := handler.NewActivityHandler(service.NewActivityService(repository.NewActivityRepository(db)))
	r.Route("/api/v1/organizations/{id}/activity", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Feed)
	})
}
