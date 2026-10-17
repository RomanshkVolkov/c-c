package http

import (
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// InitNotificationRoutes mounts the inbox.
//
// No id anywhere in these paths: every one of them answers for whoever is
// holding the token, because an inbox is not a thing you can ask about on
// somebody else's behalf.
func InitNotificationRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub, push *service.PushService) {
	inbox := service.NewNotificationService(repository.NewNotificationRepository(db))
	h := handler.NewNotificationHandler(inbox)
	orgs := repository.NewOrganizationRepository(db)
	self := handler.NewSelfNoticeHandler(service.NewSelfNoticeService(hub, inbox, func(id string) string {
		if o, err := orgs.FindByID(id); err == nil {
			return o.Name
		}
		return ""
	}))
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
		// Un agente avisa a la persona de su token, y sólo a ella (#153).
		r.Post("/self", self.Send)
		// Este dispositivo, a la campana (W2). Ver domain/push.go.
		ph := handler.NewPushHandler(push)
		r.Get("/push/key", ph.Key)
		r.Post("/push/subscriptions", ph.Subscribe)
		r.Delete("/push/subscriptions", ph.Unsubscribe)
	})
}
