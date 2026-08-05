package http

import (
	"context"

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

// InitTaskRoutes mounts the task module. Everything is JWT-authenticated and
// org-scoped through the space that owns each node.
func InitTaskRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub) {
	svc := service.NewTaskService(repository.NewTaskRepository(db), hub)
	// Same image-service client as reports: attachments are proxied so its API
	// key and the bucket never reach the desktop app.
	images := imageservice.New(
		repository.GetEnv("IMAGE_SERVICE_URL", ""),
		repository.GetEnv("IMAGE_SERVICE_CERT_CN", ""),
		repository.GetEnv("IMAGE_SERVICE_API_KEY", ""),
	)
	// Same private bucket as report screenshots: attachments are streamed back
	// through us because the bucket denies anonymous reads.
	store, err := mediastore.New(
		context.Background(),
		repository.GetEnv("REPORTS_MEDIA_BUCKET", ""),
		repository.GetEnv("REPORTS_MEDIA_REGION", ""),
		repository.GetEnv("REPORTS_MEDIA_ACCESS_KEY_ID", ""),
		repository.GetEnv("REPORTS_MEDIA_SECRET_ACCESS_KEY", ""),
	)
	if err != nil {
		lg.Error("task attachment store init failed: " + err.Error())
	}
	h := handler.NewTaskHandler(svc, images, store)

	// The navigator: spaces → folders → lists.
	r.Route("/api/v1/task-spaces", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Tree)
		r.Post("/", h.CreateSpace)
		r.Patch("/{id}", h.UpdateSpace)
		r.Delete("/{id}", h.DeleteSpace)
		r.Post("/{id}/folders", h.CreateFolder)
		r.Post("/{id}/lists", h.CreateList)
		r.Post("/{id}/move", h.MoveSpace)
	})

	r.Route("/api/v1/task-folders", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateFolder)
		r.Delete("/{id}", h.DeleteFolder)
		r.Post("/{id}/move", h.MoveFolder)
	})

	r.Route("/api/v1/task-lists", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateList)
		r.Delete("/{id}", h.DeleteList)
		r.Post("/{id}/move", h.MoveList)
		r.Get("/{id}/board", h.Board)
		r.Post("/{id}/statuses", h.CreateStatus)
		r.Post("/{id}/tasks", h.CreateTask)
	})

	r.Route("/api/v1/task-statuses", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateStatus)
		r.Post("/{id}/move", h.MoveStatus)
		r.Delete("/{id}", h.DeleteStatus) // ?moveTo=<statusId> absorbs its tasks
	})

	r.Route("/api/v1/tasks", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		// Across every list, unlike the board. The dashboard's pending list.
		r.Get("/", h.ListOpen)
		r.Get("/{id}", h.GetTask)
		r.Patch("/{id}", h.UpdateTask)
		r.Delete("/{id}", h.DeleteTask)
		r.Post("/{id}/move", h.MoveTask)
		r.Post("/{id}/comments", h.AddComment)
		r.Patch("/{id}/comments/{commentId}", h.EditComment)
		r.Delete("/{id}/comments/{commentId}", h.DeleteComment)
		r.Post("/{id}/attachments", h.UploadAttachment)
		r.Delete("/{id}/attachments/{attachmentId}", h.DeleteAttachment)
	})

	// Outside the JWT group: a webview <img> can't send an Authorization header,
	// so this one authorizes from `?token=` as well. Same pattern as the report
	// image proxy.
	r.Get("/api/v1/tasks/{id}/attachments/{attachmentId}/raw", h.RawAttachment)

	// Docs: one markdown overview per space/folder/list, sharing the task
	// module's image-service client and media store.
	docH := handler.NewDocHandler(
		service.NewDocService(repository.NewDocRepository(db)), images, store,
	)
	r.Route("/api/v1/docs", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", docH.Index) // ?orgId= — which nodes have a document
		r.Get("/{kind}/{ownerId}", docH.Get)
		r.Put("/{kind}/{ownerId}", docH.Save)
		r.Post("/{id}/attachments", docH.UploadAttachment)
		r.Delete("/{id}/attachments/{attachmentId}", docH.DeleteAttachment)
	})
	// Outside the JWT group: an <img> can't send the Authorization header.
	r.Get("/api/v1/docs/{id}/attachments/{attachmentId}/raw", docH.RawAttachment)

	r.Route("/api/v1/task-tags", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.ListTags)
		r.Post("/", h.CreateTag)
	})

	// Notes: a separate, personally-owned module (see note.go's package doc).
	// Mounted here, not given its own InitRoutes call, so it reuses the
	// image-service client and media store already built above instead of
	// constructing a third copy of both from the same env vars.
	InitNoteRoutes(db, r, images, store)
}
