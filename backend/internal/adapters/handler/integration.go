package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type IntegrationHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	Delete(w http.ResponseWriter, r *http.Request)
	Reveal(w http.ResponseWriter, r *http.Request)
	Launch(w http.ResponseWriter, r *http.Request)
	Proxy(w http.ResponseWriter, r *http.Request)
}

type integrationHandler struct {
	servers *service.ServerService
	svc     *service.IntegrationService
}

func NewIntegrationHandler(servers *service.ServerService, svc *service.IntegrationService) IntegrationHandler {
	return &integrationHandler{servers: servers, svc: svc}
}

// serverScope loads the server named in the URL, confirms it's a kubernetes hub,
// and enforces a minimum org role (superadmin bypasses). Returns the server.
func (h *integrationHandler) serverScope(w http.ResponseWriter, r *http.Request, min domain.OrgRole) (*domain.ServerResponse, bool) {
	// La pertenencia antes que el tipo: decirle «no es kubernetes» a quien no
	// es de la org ya le confirma que el servidor existe, y de qué tipo es.
	server, ok := scopeServer(w, r, h.servers, min)
	if !ok {
		return nil, false
	}
	if server.Type != domain.ServerTypeKubernetes {
		SendErrorResponse(w, http.StatusBadRequest, "Not a kubernetes server", "wrong-type")
		return nil, false
	}
	return server, true
}

// roleMeets mirrors the backend rank admin>member>viewer.
func roleMeets(have, min domain.OrgRole) bool {
	rank := map[domain.OrgRole]int{domain.OrgRoleAdmin: 3, domain.OrgRoleMember: 2, domain.OrgRoleViewer: 1}
	return rank[have] >= rank[min]
}

// ownedIntegration additionally loads the integration and verifies it belongs to
// the server in the URL (anti cross-tenant).
func (h *integrationHandler) ownedIntegration(w http.ResponseWriter, r *http.Request, server *domain.ServerResponse) (*domain.ServerIntegration, bool) {
	it, err := h.svc.Find(chi.URLParam(r, "iid"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Integration not found", "not-found")
		return nil, false
	}
	if it.ServerID != server.ID {
		SendErrorResponse(w, http.StatusNotFound, "Integration not found", "not-found")
		return nil, false
	}
	return it, true
}

func (h *integrationHandler) List(w http.ResponseWriter, r *http.Request) {
	server, ok := h.serverScope(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	items, err := h.svc.List(server.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list integrations", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.IntegrationResponse]{Success: true, Data: items})
}

func (h *integrationHandler) Create(w http.ResponseWriter, r *http.Request) {
	server, ok := h.serverScope(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateIntegrationRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	it, err := h.svc.Create(server.ID, server.OrgID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create integration", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.IntegrationResponse]{Success: true, Data: it})
}

func (h *integrationHandler) Update(w http.ResponseWriter, r *http.Request) {
	server, ok := h.serverScope(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	it, ok := h.ownedIntegration(w, r, server)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateIntegrationRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.Update(it.ID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update integration", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Integration updated"})
}

func (h *integrationHandler) Delete(w http.ResponseWriter, r *http.Request) {
	server, ok := h.serverScope(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	it, ok := h.ownedIntegration(w, r, server)
	if !ok {
		return
	}
	if err := h.svc.Delete(it.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete integration", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Integration deleted"})
}

// Reveal returns the decrypted secret — writers (member/admin) only.
func (h *integrationHandler) Reveal(w http.ResponseWriter, r *http.Request) {
	server, ok := h.serverScope(w, r, domain.OrgRoleMember)
	if !ok {
		return
	}
	it, ok := h.ownedIntegration(w, r, server)
	if !ok {
		return
	}
	secret, err := h.svc.Reveal(it.ID)
	if err != nil {
		if errors.Is(err, repository.ErrIntegrationNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Integration not found", "not-found")
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to reveal secret", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.RevealResponse]{Success: true, Data: domain.RevealResponse{Secret: secret}})
}
