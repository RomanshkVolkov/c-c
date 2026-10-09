package http

import (
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// GitHubConfigFromEnv: la App de GitHub de este servidor. Sin slug y secreto
// del webhook, todo lo de GitHub contesta 503 y la app lo dice.
func GitHubConfigFromEnv() service.GitHubConfig {
	return service.GitHubConfig{
		AppSlug:       repository.GetEnv("GITHUB_APP_SLUG", ""),
		WebhookSecret: repository.GetEnv("GITHUB_WEBHOOK_SECRET", ""),
	}
}

// GitHubAppKeyFromEnv: con qué escribe la App en GitHub (R6). Sin id o sin
// llave, la App comenta en las tareas y no escribe en GitHub.
//
// La llave admite los saltos de línea escritos como `\n`, que es como suele
// quedar un PEM pegado en un secret de una sola línea.
func GitHubAppKeyFromEnv() service.GitHubAppKey {
	id, _ := strconv.ParseInt(repository.GetEnv("GITHUB_APP_ID", ""), 10, 64)
	pem := strings.ReplaceAll(repository.GetEnv("GITHUB_APP_PRIVATE_KEY", ""), `\n`, "\n")
	if id == 0 || pem == "" {
		return service.GitHubAppKey{}
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(pem))
	if err != nil {
		lg.Error("github app: the private key does not parse: " + err.Error())
		return service.GitHubAppKey{}
	}
	return service.GitHubAppKey{AppID: id, Key: key}
}

func InitGitHubRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub, cfg service.GitHubConfig) {
	InitGitHubRoutesWith(r, service.NewGitHubService(repository.NewGitHubRepository(db), cfg, hub))
}

func InitGitHubRoutesWith(r *chi.Mux, svc *service.GitHubService) {
	h := handler.NewGitHubHandler(svc)

	// Fuera del JWT: el webhook lo firma GitHub, y al setup llega el navegador
	// de quien instaló, con el `state` firmado que le dimos.
	r.Post("/webhooks/github", h.Webhook)
	r.Get("/webhooks/github/setup", h.Setup)

	// Enlazar a mano una PR a una tarea: bajo la tarea, con el JWT o un token
	// con `tasks:write` (ver `patWritable`).
	r.With(middleware.AuthMiddleware).Post("/api/v1/tasks/{id}/git/prs", h.LinkTaskPR)
	r.Route("/api/v1/organizations/{id}/github", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Status)
		r.Post("/link", h.Link)
		r.Patch("/repos/{repoId}", h.UpdateRepo)
	})
}
