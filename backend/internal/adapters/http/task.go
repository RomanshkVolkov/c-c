package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// InitTaskRoutes mounts the task module. Everything is JWT-authenticated and
// org-scoped through the space that owns each node.
func InitTaskRoutes(db *gorm.DB, r *chi.Mux) {
	svc := service.NewTaskService(repository.NewTaskRepository(db))
	// Same image-service client as reports: attachments are proxied so its API
	// key and the bucket never reach the desktop app.
	images := imageservice.New(
		repository.GetEnv("IMAGE_SERVICE_URL", ""),
		repository.GetEnv("IMAGE_SERVICE_CERT_CN", ""),
		repository.GetEnv("IMAGE_SERVICE_API_KEY", ""),
	)
	h := handler.NewTaskHandler(svc, images)

	// The navigator: spaces → folders → lists.
	r.Route("/api/v1/task-spaces", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Tree)
		r.Post("/", h.CreateSpace)
		r.Patch("/{id}", h.UpdateSpace)
		r.Delete("/{id}", h.DeleteSpace)
		r.Post("/{id}/folders", h.CreateFolder)
		r.Post("/{id}/lists", h.CreateList)
	})

	r.Route("/api/v1/task-folders", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateFolder)
		r.Delete("/{id}", h.DeleteFolder)
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

	r.Route("/api/v1/task-tags", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.ListTags)
		r.Post("/", h.CreateTag)
	})
}
