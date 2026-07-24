package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type K8sHandler interface {
	Routes(w http.ResponseWriter, r *http.Request)
	Health(w http.ResponseWriter, r *http.Request)
}

type k8sHandler struct {
	servers *service.ServerService
	hub     *service.K8sHubService
}

func NewK8sHandler(servers *service.ServerService, hub *service.K8sHubService) K8sHandler {
	return &k8sHandler{servers: servers, hub: hub}
}

// authorize loads the server, verifies it's a kubernetes hub the caller may see
// (member of its org, or superadmin), and that the cluster API is reachable.
func (h *k8sHandler) authorize(w http.ResponseWriter, r *http.Request) bool {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return false
	}
	server, err := h.servers.Find(chi.URLParam(r, "id"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", "not-found")
		return false
	}
	if server.Type != domain.ServerTypeKubernetes {
		SendErrorResponse(w, http.StatusBadRequest, "Not a kubernetes server", "wrong-type")
		return false
	}
	_, member := user.RoleInOrg(server.OrgID)
	if !user.Superadmin && !member {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", "not-found") // anti-IDOR
		return false
	}
	if !h.hub.Available() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Cluster API unavailable", "not-in-cluster")
		return false
	}
	return true
}

func (h *k8sHandler) Routes(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	data, err := h.hub.Routes(r.Context())
	if err != nil {
		SendErrorResponse(w, http.StatusBadGateway, "Failed to read routes", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.K8sRoutesResponse]{Success: true, Data: data})
}

func (h *k8sHandler) Health(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	data, err := h.hub.Health(r.Context())
	if err != nil {
		SendErrorResponse(w, http.StatusBadGateway, "Failed to read cluster health", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.K8sHealth]{Success: true, Data: data})
}
