package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitGitHubRoutes(db *gorm.DB, r *chi.Mux) {
	repo := repository.NewServerRepository(db)
	svc := service.NewGitHubService(repo)
	h := handler.NewGitHubHandler(svc)

	r.Route("/api/v1/servers/{id}/github", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)

		// Token management
		r.Put("/token", h.SetToken)
		r.Delete("/token", h.DeleteToken)
		r.Get("/token/status", h.TokenStatus)

		// Repo-scoped operations
		r.Get("/{owner}/{repo}/secrets", h.ListSecrets)
		r.Get("/{owner}/{repo}/variables", h.ListVariables)
		r.Put("/{owner}/{repo}/secrets/{name}", h.SetSecret)
		r.Delete("/{owner}/{repo}/secrets/{name}", h.DeleteSecret)
		r.Put("/{owner}/{repo}/variables/{name}", h.SetVariable)
		r.Delete("/{owner}/{repo}/variables/{name}", h.DeleteVariable)
	})
}
