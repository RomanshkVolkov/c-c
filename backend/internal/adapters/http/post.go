package http

import (
	"context"
	"net/http"

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

// InitPostRoutes: el muro de feedback y comunicados (ver domain/post.go). Las
// imágenes van por el mismo image-service y el mismo bucket que las del chat.
func InitPostRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub) {
	images := imageservice.New(
		repository.GetEnv("IMAGE_SERVICE_URL", ""),
		repository.GetEnv("IMAGE_SERVICE_CERT_CN", ""),
		repository.GetEnv("IMAGE_SERVICE_API_KEY", ""),
	)
	store, err := mediastore.New(
		context.Background(),
		repository.GetEnv("REPORTS_MEDIA_BUCKET", ""),
		repository.GetEnv("REPORTS_MEDIA_REGION", ""),
		repository.GetEnv("REPORTS_MEDIA_ACCESS_KEY_ID", ""),
		repository.GetEnv("REPORTS_MEDIA_SECRET_ACCESS_KEY", ""),
	)
	if err != nil {
		lg.Error("post attachment store init failed: " + err.Error())
	}
	inbox := service.NewNotificationService(repository.NewNotificationRepository(db))
	svc := service.NewPostService(repository.NewPostRepository(db), repository.NewReactionRepository(db), hub).
		WithNotifier(inbox)
	mountPostRoutes(r, handler.NewPostHandler(svc, images, store))
}

type postRoutes interface {
	List(http.ResponseWriter, *http.Request)
	Create(http.ResponseWriter, *http.Request)
	Get(http.ResponseWriter, *http.Request)
	Delete(http.ResponseWriter, *http.Request)
	Update(http.ResponseWriter, *http.Request)
	Pin(http.ResponseWriter, *http.Request)
	Publish(http.ResponseWriter, *http.Request)
	ReactComment(http.ResponseWriter, *http.Request)
	Comment(http.ResponseWriter, *http.Request)
	DeleteComment(http.ResponseWriter, *http.Request)
	React(http.ResponseWriter, *http.Request)
	Seen(http.ResponseWriter, *http.Request)
	Upload(http.ResponseWriter, *http.Request)
	Raw(http.ResponseWriter, *http.Request)
}

// mountPostRoutes: todo con JWT salvo los bytes de una imagen, que pide un
// <img> sin cabeceras (lleva su propio `?token=`). Ver
// TestOnlyTheRawPostImageSkipsAuth.
func mountPostRoutes(r chi.Router, h postRoutes) {
	r.Get("/api/v1/posts/attachments/{attachmentId}/raw", h.Raw)
	r.Route("/api/v1/posts", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Post("/seen", h.Seen)
		r.Post("/attachments", h.Upload)
		r.Get("/{id}", h.Get)
		r.Delete("/{id}", h.Delete)
		r.Patch("/{id}", h.Update)
		r.Post("/{id}/pin", h.Pin)
		r.Post("/{id}/publish", h.Publish)
		r.Post("/{id}/comments/{commentId}/reactions", h.ReactComment)
		r.Post("/{id}/comments", h.Comment)
		r.Delete("/{id}/comments/{commentId}", h.DeleteComment)
		r.Post("/{id}/reactions", h.React)
	})
}
