package http

import (
	"context"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Diez segundos, como la grabación: dos vueltas vacías cierran una llamada,
// así que el resumen sale como mucho medio minuto después de colgar.
const callSessionTick = 10 * time.Second

// InitCallSessionRoutes: las llamadas guardadas, una para todo el proceso. Va
// antes que las tareas, la grabación y las reuniones, que la usan: dar la
// entrada a una sala abre su sesión, y una grabación lista va en su resumen.
func InitCallSessionRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub) *service.CallSessionService {
	lk := lkclient.New(
		repository.GetEnv("LIVEKIT_URL", ""),
		repository.GetEnv("LIVEKIT_API_KEY", ""),
		repository.GetEnv("LIVEKIT_API_SECRET", ""),
	)
	svc := service.NewCallSessionService(
		repository.NewCallSessionRepository(db), repository.NewRecordingRepository(db), lk,
	).WithHub(hub).WithSummarizer(
		// Con el buzón, como el de la grabación: el resumen avisa a quien
		// sigue el canal igual que avisaba el aviso de la grabación.
		service.NewChatService(repository.NewChatRepository(db), hub).
			WithNotifier(service.NewNotificationService(repository.NewNotificationRepository(db))),
	)
	h := handler.NewCallSessionHandler(svc)
	r.Route("/api/v1/call-sessions/{id}", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Get)
		// El chat de la llamada: se lee siempre, se escribe mientras dura.
		r.Get("/messages", h.ListMessages)
		r.Post("/messages", h.PostMessage)
		r.Patch("/messages/{mid}", h.EditMessage)
		r.Delete("/messages/{mid}", h.WithdrawMessage)
	})
	startCallSessionClock(svc)
	return svc
}

// startCallSessionClock: corre en todas las réplicas; cada sesión la hace una,
// por `ClaimTick`. Sin LiveKit no hay salas que mirar.
func startCallSessionClock(svc *service.CallSessionService) {
	if repository.GetEnv("LIVEKIT_URL", "") == "" {
		return
	}
	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	go func() {
		defer parar()
		ticker := time.NewTicker(callSessionTick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				svc.Tick(ctx, time.Now().UTC())
			}
		}
	}()
}
