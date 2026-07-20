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
	DeleteServer(w http.ResponseWriter, r *http.Request)
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
	servers, err := h.svc.List(user.OrgIDs())
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
	if !member || !role.CanWrite() {
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
	if !member || role != domain.OrgRoleAdmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "admin-required")
		return
	}

	if err := h.svc.Delete(id); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete server", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Server deleted"})
}
