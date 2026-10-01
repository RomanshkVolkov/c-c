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

// GitHubConfigFromEnv: la App de GitHub de este servidor. Sin las dos, todo lo
// de GitHub contesta 503 y la app lo dice.
func GitHubConfigFromEnv() service.GitHubConfig {
	return service.GitHubConfig{
		AppSlug:       repository.GetEnv("GITHUB_APP_SLUG", ""),
		WebhookSecret: repository.GetEnv("GITHUB_WEBHOOK_SECRET", ""),
	}
}

func InitGitHubRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub, cfg service.GitHubConfig) {
	h := handler.NewGitHubHandler(service.NewGitHubService(repository.NewGitHubRepository(db), cfg, hub))

	// Fuera del JWT: el webhook lo firma GitHub, y al setup llega el navegador
	// de quien instaló, con el `state` firmado que le dimos.
	r.Post("/webhooks/github", h.Webhook)
	r.Get("/webhooks/github/setup", h.Setup)

	r.Route("/api/v1/organizations/{id}/github", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Status)
		r.Post("/link", h.Link)
		r.Patch("/repos/{repoId}", h.UpdateRepo)
	})
}
