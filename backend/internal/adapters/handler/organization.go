package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type OrganizationHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	Delete(w http.ResponseWriter, r *http.Request)
	ListMembers(w http.ResponseWriter, r *http.Request)
	AddMember(w http.ResponseWriter, r *http.Request)
	UpdateMember(w http.ResponseWriter, r *http.Request)
	RemoveMember(w http.ResponseWriter, r *http.Request)
}

type organizationHandler struct {
	svc *service.OrganizationService
}

func NewOrganizationHandler(svc *service.OrganizationService) OrganizationHandler {
	return &organizationHandler{svc: svc}
}

// mapOrgError translates org domain/service errors to HTTP status codes.
// Returns false when err is not an org error the caller should map itself.
func mapOrgError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, service.ErrForbidden):
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", err.Error())
	case errors.Is(err, service.ErrLastAdmin):
		SendErrorResponse(w, http.StatusConflict, "Cannot remove last admin", err.Error())
	case errors.Is(err, repository.ErrOrgNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Organization not found", err.Error())
	case errors.Is(err, repository.ErrOrgSlugTaken):
		SendErrorResponse(w, http.StatusConflict, "Slug already in use", err.Error())
	case errors.Is(err, repository.ErrOrgHasServers):
		SendErrorResponse(w, http.StatusConflict, "Organization still has servers", err.Error())
	case errors.Is(err, repository.ErrOrgNotEmpty):
		SendErrorResponse(w, http.StatusConflict, "Organization still has report-projects or collections", err.Error())
	case errors.Is(err, repository.ErrMembershipNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Membership not found", err.Error())
	case errors.Is(err, repository.ErrUserNotFound):
		SendErrorResponse(w, http.StatusNotFound, "User not found", err.Error())
	default:
		return false
	}
	return true
}

func (h *organizationHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	orgs, err := h.svc.List(user.UserID, user.Superadmin)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list organizations", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.OrganizationResponse]{Success: true, Data: orgs})
}

func (h *organizationHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.CreateOrganizationRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	org, err := h.svc.Create(user.UserID, req)
	if err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create organization", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.OrganizationResponse]{Success: true, Data: org})
}

func (h *organizationHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.UpdateOrganizationRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	org, err := h.svc.Update(user.UserID, chi.URLParam(r, "id"), req, user.Superadmin)
	if err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update organization", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.OrganizationResponse]{Success: true, Data: org})
}

func (h *organizationHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if err := h.svc.Delete(user.UserID, chi.URLParam(r, "id"), user.Superadmin); err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete organization", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Organization deleted"})
}

func (h *organizationHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	members, err := h.svc.ListMembers(user.UserID, chi.URLParam(r, "id"), user.Superadmin)
	if err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list members", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.MemberResponse]{Success: true, Data: members})
}

func (h *organizationHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.AddMemberRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.AddMember(user.UserID, chi.URLParam(r, "id"), req, user.Superadmin); err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to add member", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Member added"})
}

func (h *organizationHandler) UpdateMember(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.UpdateMemberRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.UpdateMemberRole(user.UserID, chi.URLParam(r, "id"), chi.URLParam(r, "userId"), req, user.Superadmin); err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update member", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Member updated"})
}

func (h *organizationHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if err := h.svc.RemoveMember(user.UserID, chi.URLParam(r, "id"), chi.URLParam(r, "userId"), user.Superadmin); err != nil {
		if mapOrgError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to remove member", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Member removed"})
}
