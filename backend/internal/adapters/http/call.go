package http

import (
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// InitCallRoutes monta las reuniones con invitados (W3).
func InitCallRoutes(db *gorm.DB, r *chi.Mux, recordings *service.RecordingService) {
	voice := service.NewVoiceService(
		repository.GetEnv("LIVEKIT_URL", ""),
		repository.GetEnv("LIVEKIT_API_KEY", ""),
		repository.GetEnv("LIVEKIT_API_SECRET", ""),
	)
	lk := lkclient.New(
		repository.GetEnv("LIVEKIT_URL", ""),
		repository.GetEnv("LIVEKIT_API_KEY", ""),
		repository.GetEnv("LIVEKIT_API_SECRET", ""),
	)
	svc := service.NewCallInviteService(repository.NewCallInviteRepository(db), voice, lk, recordings)
	mountCallRoutes(r, handler.NewCallHandler(svc, recordings, voice, repository.NewTaskRepository(db)))
}

// mountCallRoutes, aparte para que la prueba de las puertas recorra **este**
// enrutado y no una copia.
func mountCallRoutes(r chi.Router, h handler.CallHandler) {
	r.Route("/api/v1/call-invites", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Get("/{id}", h.Get)
		r.Delete("/{id}", h.Revoke)
		r.Post("/{id}/voice/token", h.Token)
		r.Post("/{id}/participants/{identity}/remove", h.Kick)
		r.Get("/{id}/recordings/policy", h.RecordingPolicy)
		r.Post("/{id}/recordings", h.StartRecording)
	})

	// La puerta de quien no tiene cuenta. **Sin JWT, a propósito, y sólo
	// estas dos**: lo que las abre es el enlace firmado que viaja en el cuerpo.
	// Hay una prueba que recorre el enrutado y falla si aparece otra.
	r.Post("/api/v1/public/calls/inspect", h.PublicInspect)
	r.Post("/api/v1/public/calls/join", h.PublicJoin)
}
