package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type ServerHandler interface {
	ListServers(w http.ResponseWriter, r *http.Request)
	CreateServer(w http.ResponseWriter, r *http.Request)
	UpdateServer(w http.ResponseWriter, r *http.Request)
	DeleteServer(w http.ResponseWriter, r *http.Request)
	ReportAgentStatus(w http.ResponseWriter, r *http.Request)
}

type serverHandler struct {
	svc *service.ServerService
}

func NewServerHandler(svc *service.ServerService) ServerHandler {
	return &serverHandler{svc: svc}
}

func (h *serverHandler) ListServers(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	servers, err := h.svc.List(user.OrgIDs(), user.Superadmin)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list servers", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ServerResponse]{Success: true, Data: servers})
}

func (h *serverHandler) CreateServer(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.CreateServerRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}

	// Must be admin/member of the target org to register a server in it.
	role, member := user.RoleInOrg(req.OrgID)
	if !user.Superadmin && (!member || !role.CanWrite()) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-a-writer-in-org")
		return
	}

	server, err := h.svc.Create(req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create server", err.Error())
		return
	}

	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ServerResponse]{Success: true, Data: server})
}

// UpdateServer edits connection metadata. Writers (admin/member) of the
// server's org, or a superadmin.
func (h *serverHandler) UpdateServer(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	server, err := h.svc.Find(id)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", err.Error())
		return
	}
	role, member := user.RoleInOrg(server.OrgID)
	if !user.Superadmin && (!member || !role.CanWrite()) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-a-writer-in-org")
		return
	}
	req, err := ValidateRequest[domain.UpdateServerRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	updated, err := h.svc.Update(id, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update server", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ServerResponse]{Success: true, Data: updated})
}

// ReportAgentStatus: la app probó el agente y cuenta qué pasó.
//
// Pertenecer a la organización basta —no exige poder escribir—: esto no cambia
// la configuración de nada, sólo anota si contestó. Pedir rol de escritura
// dejaría a un `viewer` mirando un «pending» eterno.
func (h *serverHandler) ReportAgentStatus(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	server, err := h.svc.Find(id)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", err.Error())
		return
	}
	if _, member := user.RoleInOrg(server.OrgID); !user.Superadmin && !member {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-a-member")
		return
	}
	req, err := ValidateRequest[domain.ReportAgentStatusRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.ReportAgentStatus(id, req.Status); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record status", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Recorded"})
}

func (h *serverHandler) DeleteServer(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")

	server, err := h.svc.Find(id)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", err.Error())
		return
	}
	// Deletion is admin-only within the server's org.
	role, member := user.RoleInOrg(server.OrgID)
	if !user.Superadmin && (!member || role != domain.OrgRoleAdmin) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "admin-required")
		return
	}

	if err := h.svc.Delete(id); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete server", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Server deleted"})
}
