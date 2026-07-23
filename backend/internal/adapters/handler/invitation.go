package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type InvitationHandler interface {
	Create(w http.ResponseWriter, r *http.Request)
	ListForOrg(w http.ResponseWriter, r *http.Request)
	Revoke(w http.ResponseWriter, r *http.Request)
	ListMine(w http.ResponseWriter, r *http.Request)
	Accept(w http.ResponseWriter, r *http.Request)
	Decline(w http.ResponseWriter, r *http.Request)
}

type invitationHandler struct {
	svc *service.InvitationService
}

func NewInvitationHandler(svc *service.InvitationService) InvitationHandler {
	return &invitationHandler{svc: svc}
}

func mapInvitationError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrInvitationNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Invitation not found", err.Error())
	case errors.Is(err, repository.ErrInvitationExists):
		SendErrorResponse(w, http.StatusConflict, "A pending invitation already exists", err.Error())
	case errors.Is(err, repository.ErrAlreadyMember):
		SendErrorResponse(w, http.StatusConflict, "User is already a member", err.Error())
	case errors.Is(err, repository.ErrUserNotFound):
		SendErrorResponse(w, http.StatusNotFound, "User not found", err.Error())
	case errors.Is(err, service.ErrForbidden):
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", err.Error())
	default:
		return false
	}
	return true
}

// requireOrgAdmin gates org-side invitation endpoints: the caller must admin the
// org named in the URL, or be a superadmin.
func requireOrgAdmin(w http.ResponseWriter, r *http.Request) (*domain.ClaimsJWT, string, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, "", false
	}
	orgID := chi.URLParam(r, "id")
	role, member := user.RoleInOrg(orgID)
	if !user.Superadmin && (!member || role != domain.OrgRoleAdmin) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "admin-required")
		return nil, "", false
	}
	return user, orgID, true
}

func (h *invitationHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, orgID, ok := requireOrgAdmin(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateInvitationRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.Create(orgID, req.UserID, user.UserID, req.Role); err != nil {
		if mapInvitationError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create invitation", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[any]{Success: true, Message: "Invitation sent"})
}

func (h *invitationHandler) ListForOrg(w http.ResponseWriter, r *http.Request) {
	_, orgID, ok := requireOrgAdmin(w, r)
	if !ok {
		return
	}
	invs, err := h.svc.ListForOrg(orgID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list invitations", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.InvitationResponse]{Success: true, Data: invs})
}

func (h *invitationHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	_, orgID, ok := requireOrgAdmin(w, r)
	if !ok {
		return
	}
	if err := h.svc.Revoke(chi.URLParam(r, "invitationId"), orgID); err != nil {
		if mapInvitationError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to revoke invitation", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Invitation revoked"})
}

func (h *invitationHandler) ListMine(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	invs, err := h.svc.ListForUser(user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list invitations", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.InvitationResponse]{Success: true, Data: invs})
}

func (h *invitationHandler) Accept(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if err := h.svc.Accept(chi.URLParam(r, "invitationId"), user.UserID); err != nil {
		if mapInvitationError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to accept invitation", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Invitation accepted"})
}

func (h *invitationHandler) Decline(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if err := h.svc.Decline(chi.URLParam(r, "invitationId"), user.UserID); err != nil {
		if mapInvitationError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to decline invitation", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Invitation declined"})
}
