package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitAuthRoutes(db *gorm.DB, r *chi.Mux) {
	repo := repository.NewAuthRepository(db)
	svc := service.NewAuthService(repo)
	h := handler.NewAuthHandler(svc)

	r.Route("/api/v1/auth", func(r chi.Router) {
		r.Post("/login", h.Login)
		r.With(middleware.RefreshMiddleware).Post("/refresh", h.RefreshToken)
		r.With(middleware.AuthMiddleware).Get("/me", h.Me)
	})
}
