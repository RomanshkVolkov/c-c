package handler

import (
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type ServerHandler interface {
	ListServers(w http.ResponseWriter, r *http.Request)
	CreateServer(w http.ResponseWriter, r *http.Request)
	DeleteServer(w http.ResponseWriter, r *http.Request)
	DeployAgent(w http.ResponseWriter, r *http.Request)
	UpdateAgent(w http.ResponseWriter, r *http.Request)
}

type serverHandler struct {
	svc *service.ServerService
}

func NewServerHandler(svc *service.ServerService) ServerHandler {
	return &serverHandler{svc: svc}
}

func (h *serverHandler) ListServers(w http.ResponseWriter, r *http.Request) {
	servers, err := h.svc.List()
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list servers", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ServerResponse]{Success: true, Data: servers})
}

func (h *serverHandler) CreateServer(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.CreateServerRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
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
	id := chi.URLParam(r, "id")
	if err := h.svc.Delete(id); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete server", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Server deleted"})
}

func (h *serverHandler) UpdateAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.UpdateAgent(id); err != nil {
		log.Printf("[UpdateAgent] error for server %s: %v", id, err)
		SendErrorResponse(w, http.StatusInternalServerError, "Update failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Agent updated successfully"})
}

func (h *serverHandler) DeployAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.DeployAgent(id); err != nil {
		log.Printf("[DeployAgent] error for server %s: %v", id, err)
		SendErrorResponse(w, http.StatusInternalServerError, "Deploy failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Agent deployed successfully"})
}
