package http

import (
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// InitCallRoutes monta las reuniones con invitados (W3).
func InitCallRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub, recordings *service.RecordingService) {
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
	svc := service.NewCallInviteService(repository.NewCallInviteRepository(db), voice, lk, recordings).WithHub(hub)
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
		// El timbre, a la reunión: llamar a un compañero a esta sala.
		r.Post("/{id}/ring", h.Ring)
		r.Delete("/{id}/ring/{userId}", h.RingCancel)
		// La sala de espera: quién pide entrar, y la decisión de los de dentro.
		r.Get("/{id}/guests", h.Waiting)
		r.Post("/{id}/guests/{guestId}/admit", h.Admit)
		r.Post("/{id}/guests/{guestId}/reject", h.Reject)
		r.Get("/{id}/recordings/policy", h.RecordingPolicy)
		r.Post("/{id}/recordings", h.StartRecording)
	})

	// La puerta de quien no tiene cuenta. **Sin JWT, a propósito, y sólo
	// estas tres**: lo que las abre es el enlace firmado que viaja en el
	// cuerpo, y `join` no da entrada a la sala sino a la de espera. Hay una
	// prueba que recorre el enrutado y falla si aparece otra.
	r.Post("/api/v1/public/calls/inspect", h.PublicInspect)
	r.Post("/api/v1/public/calls/join", h.PublicJoin)
	r.Post("/api/v1/public/calls/status", h.PublicStatus)
}
