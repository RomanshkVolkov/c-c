package http

import (
	"context"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Cada treinta segundos.
//
// Es el retraso máximo con el que puede llegar un aviso, así que un minuto se
// notaría —una reunión que empieza a las nueve avisando a las nueve y uno— y
// cinco segundos serían diez veces más consultas para ganar algo que nadie
// percibe. La consulta es un índice sobre una tabla diminuta.
const latidoDeReuniones = 30 * time.Second

// InitMeetingRoutes monta la agenda de reuniones y arranca su reloj.
func InitMeetingRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub) {
	repo := repository.NewMeetingRepository(db)
	orgRepo := repository.NewOrganizationRepository(db)
	taskRepo := repository.NewTaskRepository(db)
	inbox := service.NewNotificationService(repository.NewNotificationRepository(db))

	svc := service.NewMeetingService(repo, orgRepo, taskRepo, inbox, hub)
	h := handler.NewMeetingHandler(svc, service.NewOrganizationService(orgRepo))

	r.Route("/api/v1/organizations/{orgId}/meetings", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		// Verla es de cualquier miembro: saber cuándo se reúne tu equipo no es
		// información de administración.
		r.Get("/", h.List)
		// El calendario: las repeticiones ya expandidas.
		r.Get("/agenda", h.Agenda)
		r.Post("/", h.Create)
	})
	r.Route("/api/v1/meetings/{id}", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/", h.Update)
		r.Delete("/", h.Delete)
		r.Put("/recipients", h.SetRecipients)
	})

	arrancarRelojDeReuniones(svc)
}

// arrancarRelojDeReuniones es lo único de este backend que actúa sin que nadie
// se lo pida.
//
// Dos detalles que lo separan del ticker de purga que ya existía y que le
// sirvió de modelo:
//
//   - **Se apaga.** Un `context` atado a las mismas señales que el servidor, en
//     vez de una goroutine que sólo muere cuando muere el proceso. Purgar a
//     medias es inocuo; timbrar mientras el pod se está cerrando, no.
//   - **Corre en las dos réplicas a la vez, y está bien.** Quién anuncia lo
//     decide la base con un UPDATE condicional (`repo.Reservar`), no este bucle.
func arrancarRelojDeReuniones(svc *service.MeetingService) {
	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	go func() {
		defer parar()
		ticker := time.NewTicker(latidoDeReuniones)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				svc.FireDue(time.Now())
			}
		}
	}()
}
