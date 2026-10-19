package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// accounts: el alta por correo (ver account.go). Sus rutas de admin cuelgan de
// la organización, así que se montan aquí.
func InitOrganizationRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub, accounts *handler.AccountHandler) {
	repo := repository.NewOrganizationRepository(db)
	svc := service.NewOrganizationService(repo).WithHub(hub)
	h := handler.NewOrganizationHandler(svc)

	invRepo := repository.NewInvitationRepository(db)
	invSvc := service.NewInvitationService(invRepo)
	inv := handler.NewInvitationHandler(invSvc)

	r.Route("/api/v1/organizations", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Patch("/{id}", h.Update)
		r.Delete("/{id}", h.Delete)
		r.Get("/{id}/members", h.ListMembers)
		r.Post("/{id}/members", h.AddMember)
		r.Patch("/{id}/members/{userId}", h.UpdateMember)
		r.Delete("/{id}/members/{userId}", h.RemoveMember)
		// Invitations (org-admin side).
		r.Get("/{id}/invitations", inv.ListForOrg)
		r.Post("/{id}/invitations", inv.Create)
		r.Post("/{id}/invitations/{invitationId}/resend", inv.Renew)
		r.Delete("/{id}/invitations/{invitationId}", inv.Revoke)
		// Dar de alta por correo: la cuenta nueva, o la invitación si ya existe.
		r.Post("/{id}/accounts", accounts.Create)
		r.Post("/{id}/accounts/{userId}/resend", accounts.Resend)
	})

	// Invitations (invitee side).
	r.Route("/api/v1/invitations", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", inv.ListMine)
		r.Post("/{invitationId}/accept", inv.Accept)
		r.Post("/{invitationId}/decline", inv.Decline)
	})
}
