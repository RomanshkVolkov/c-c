package http

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/mailer"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// MailerFromEnv: el SES de infra/terraform/email. Sin EMAIL_REGION o
// EMAIL_FROM, nil: dar de alta sigue funcionando (el admin recibe el enlace
// para pasarlo a mano) y restablecer contesta `email-off`.
func MailerFromEnv() service.Mailer {
	m, err := mailer.New(context.Background(),
		repository.GetEnv("EMAIL_REGION", ""),
		repository.GetEnv("EMAIL_FROM", ""),
		repository.GetEnv("EMAIL_CONFIGURATION_SET", ""),
		repository.GetEnv("EMAIL_ACCESS_KEY_ID", ""),
		repository.GetEnv("EMAIL_SECRET_ACCESS_KEY", ""),
	)
	if err != nil {
		lg.Error("email: " + err.Error())
		return nil
	}
	// Un *SES nil dentro de la interfaz no es una interfaz nil: el servicio
	// creería que hay correo.
	if m == nil {
		lg.Warn("email: EMAIL_REGION/EMAIL_FROM not set — sign-up links are handed to the admin and password reset is off")
		return nil
	}
	return m
}

// NewAccountHandlerFor arma el alta por correo sobre la base y el hub.
func NewAccountHandlerFor(db *gorm.DB, hub *events.Hub, mail service.Mailer) *handler.AccountHandler {
	users := repository.NewAuthRepository(db)
	svc := service.NewAccountService(
		repository.NewAccountRepository(db), users,
		repository.NewOrganizationRepository(db),
		service.NewInvitationService(repository.NewInvitationRepository(db)),
		service.NewAuthService(users).WithHub(hub),
		mail,
		repository.GetEnv("PUBLIC_WEB_URL", "https://cac.guz-studio.dev"),
	)
	return handler.NewAccountHandler(svc)
}

type publicAccountRoutes interface {
	Inspect(http.ResponseWriter, *http.Request)
	Welcome(http.ResponseWriter, *http.Request)
	Forgot(http.ResponseWriter, *http.Request)
	Reset(http.ResponseWriter, *http.Request)
}

// mountPublicAccountRoutes: las de quien todavía no tiene sesión — abrir el
// enlace del correo y pedirlo. Sin JWT a propósito; ver
// TestOnlyThePublicAccountRoutesSkipAuth.
func mountPublicAccountRoutes(r chi.Router, h publicAccountRoutes) {
	r.Route("/api/v1/public/account", func(r chi.Router) {
		r.Post("/inspect", h.Inspect)
		r.Post("/welcome", h.Welcome)
		r.Post("/forgot", h.Forgot)
		r.Post("/reset", h.Reset)
	})
}
