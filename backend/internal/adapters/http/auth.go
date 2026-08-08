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

	// Personal access tokens (read-only programmatic access, e.g. the MCP server).
	tokenSvc := service.NewTokenService(repository.NewTokenRepository(db), repo)
	tokens := handler.NewTokenHandler(tokenSvc)
	middleware.UsePATAuthenticator(tokenSvc.Authenticate)

	r.Route("/api/v1/auth", func(r chi.Router) {
		r.Post("/login", h.Login)
		r.With(middleware.RefreshMiddleware).Post("/refresh", h.RefreshToken)
		r.With(middleware.AuthMiddleware).Get("/me", h.Me)
		r.With(middleware.AuthMiddleware).Post("/change-password", h.ChangePassword)
		// Token management is JWT-only in practice: minting/revoking are non-GET,
		// which the middleware refuses for PATs.
		r.With(middleware.AuthMiddleware).Get("/tokens", tokens.List)
		r.With(middleware.AuthMiddleware).Post("/tokens", tokens.Create)
		r.With(middleware.AuthMiddleware).Patch("/tokens/{id}", tokens.Update)
		r.With(middleware.AuthMiddleware).Delete("/tokens/{id}", tokens.Revoke)
	})
}
