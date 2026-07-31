package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// InitNoteRoutes mounts the personal notes module. Called from InitTaskRoutes,
// which already builds the shared image-service client and media store — see
// the call site for why a third construction was worth avoiding.
func InitNoteRoutes(db *gorm.DB, r *chi.Mux, images *imageservice.Client, store *mediastore.Store) {
	h := handler.NewNoteHandler(service.NewNoteService(repository.NewNoteRepository(db)), images, store)

	r.Route("/api/v1/notes", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Tree)
		r.Post("/", h.Create)
		r.Get("/search", h.Search)
		r.Put("/tree", h.MoveTree)
		r.Get("/{id}", h.Get)
		r.Patch("/{id}", h.Update)
		r.Delete("/{id}", h.Delete)
		r.Post("/{id}/attachments", h.UploadAttachment)
		r.Delete("/{id}/attachments/{attachmentId}", h.DeleteAttachment)
	})
	// Outside the JWT group: an <img> can't send the Authorization header, so
	// this one accepts `?token=` too. Same pattern as tasks and docs.
	r.Get("/api/v1/notes/{id}/attachments/{attachmentId}/raw", h.RawAttachment)
}
