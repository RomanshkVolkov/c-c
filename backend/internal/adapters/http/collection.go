package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitCollectionRoutes(db *gorm.DB, r *chi.Mux) {
	collectionRepo := repository.NewCollectionRepository(db)
	authRepo := repository.NewAuthRepository(db)
	collectionSvc := service.NewCollectionService(collectionRepo, authRepo)
	authSvc := service.NewAuthService(authRepo)

	collections := handler.NewCollectionHandler(collectionSvc)
	users := handler.NewUserHandler(authSvc)

	r.Route("/api/v1/collections", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", collections.List)
		r.Post("/", collections.Create)
		r.Get("/{id}", collections.Get)
		r.Put("/{id}", collections.Update)
		r.Delete("/{id}", collections.Delete)
		r.Put("/{id}/tree", collections.ReplaceTree)
		r.Get("/{id}/shares", collections.ListShares)
		r.Post("/{id}/shares", collections.Share)
		r.Delete("/{id}/shares/{userId}", collections.Unshare)
	})

	r.Route("/api/v1/users", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/search", users.Search)
	})
}
