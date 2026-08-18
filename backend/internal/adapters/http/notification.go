package http

import (
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// InitNotificationRoutes mounts the inbox.
//
// No id anywhere in these paths: every one of them answers for whoever is
// holding the token, because an inbox is not a thing you can ask about on
// somebody else's behalf.
func InitNotificationRoutes(db *gorm.DB, r *chi.Mux) {
	h := handler.NewNotificationHandler(
		service.NewNotificationService(repository.NewNotificationRepository(db)),
	)
	search := handler.NewSearchHandler(
		service.NewSearchService(repository.NewSearchRepository(db)),
	)
	r.Route("/api/v1/search", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", search.Search)
	})

	r.Route("/api/v1/notifications", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Feed)
		r.Post("/read", h.MarkRead)
		r.Post("/read-all", h.MarkAllRead)
		r.Get("/preferences", h.Prefs)
		r.Patch("/preferences", h.SavePrefs)
	})
}
