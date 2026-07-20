package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type ReportProjectHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	Delete(w http.ResponseWriter, r *http.Request)
	RotateKey(w http.ResponseWriter, r *http.Request)
}

type reportProjectHandler struct {
	svc *service.ReportProjectService
}

func NewReportProjectHandler(svc *service.ReportProjectService) ReportProjectHandler {
	return &reportProjectHandler{svc: svc}
}

func mapReportProjectError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrReportProjectNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Report project not found", err.Error())
	case errors.Is(err, repository.ErrReportProjectSlugTaken):
		SendErrorResponse(w, http.StatusConflict, "Slug already in use", err.Error())
	case errors.Is(err, service.ErrAssigneeNotMember):
		SendErrorResponse(w, http.StatusBadRequest, "Default assignee is not a member of the organization", err.Error())
	default:
		return false
	}
	return true
}

func (h *reportProjectHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	projects, err := h.svc.List(user.OrgIDs())
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list report projects", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ReportProjectResponse]{Success: true, Data: projects})
}

func (h *reportProjectHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.CreateReportProjectRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	role, member := user.RoleInOrg(req.OrgID)
	if !member || !role.CanWrite() {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-a-writer-in-org")
		return
	}
	result, err := h.svc.Create(req)
	if err != nil {
		if mapReportProjectError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create report project", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CreateReportProjectResult]{Success: true, Data: result})
}

// requireWriter loads the project, verifies it exists and the caller may write
// to its org. minAdmin=true additionally requires the admin role.
func (h *reportProjectHandler) requireWriter(w http.ResponseWriter, r *http.Request, minAdmin bool) (*domain.ReportProject, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, false
	}
	p, err := h.svc.Find(chi.URLParam(r, "id"))
	if err != nil {
		if !mapReportProjectError(w, err) {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to load report project", err.Error())
		}
		return nil, false
	}
	role, member := user.RoleInOrg(p.OrgID)
	if !member || (minAdmin && role != domain.OrgRoleAdmin) || (!minAdmin && !role.CanWrite()) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "insufficient-role")
		return nil, false
	}
	return p, true
}

func (h *reportProjectHandler) Update(w http.ResponseWriter, r *http.Request) {
	p, ok := h.requireWriter(w, r, false)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateReportProjectRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	updated, err := h.svc.Update(p.ID, req)
	if err != nil {
		if mapReportProjectError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update report project", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportProjectResponse]{Success: true, Data: updated})
}

func (h *reportProjectHandler) Delete(w http.ResponseWriter, r *http.Request) {
	p, ok := h.requireWriter(w, r, true)
	if !ok {
		return
	}
	if err := h.svc.Delete(p.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete report project", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Report project deleted"})
}

func (h *reportProjectHandler) RotateKey(w http.ResponseWriter, r *http.Request) {
	p, ok := h.requireWriter(w, r, true)
	if !ok {
		return
	}
	key, err := h.svc.RotateKey(p.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to rotate key", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]string]{Success: true, Data: map[string]string{"ingestKey": key}})
}
