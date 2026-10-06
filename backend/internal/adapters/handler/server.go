package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type ServerHandler interface {
	ListServers(w http.ResponseWriter, r *http.Request)
	GetServer(w http.ResponseWriter, r *http.Request)
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

// GetServer: un servidor por su id.
//
// Existe porque las páginas de un servidor lo recibían en el `state` del
// router, y ese estado no sobrevive a recargar: F5 en la página de un servidor
// te devolvía al panel. Con esto cada página lo pide por la dirección.
func (h *serverHandler) GetServer(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.svc, domain.OrgRoleViewer)
	if !ok {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ServerResponse]{Success: true, Data: server})
}

// scopeServer carga el servidor de la URL y exige un rol mínimo en su org (el
// superadmin pasa). A quien no es de la org se le contesta **404**, no 403:
// confirmar que el id existe ya sería contar algo. Vale para cualquier tipo de
// servidor; el de integraciones (`serverScope`) exige además kubernetes.
func scopeServer(w http.ResponseWriter, r *http.Request, svc *service.ServerService, min domain.OrgRole) (*domain.ServerResponse, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, false
	}
	server, err := svc.Find(chi.URLParam(r, "id"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", "not-found")
		return nil, false
	}
	role, member := user.RoleInOrg(server.OrgID)
	if user.Superadmin {
		role, member = domain.OrgRoleAdmin, true
	}
	if !member {
		SendErrorResponse(w, http.StatusNotFound, "Server not found", "not-found")
		return nil, false
	}
	if !roleMeets(role, min) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "insufficient-role")
		return nil, false
	}
	return server, true
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
	// Un servidor kubernetes no es «un servidor del cliente»: sus vistas leen
	// **el clúster de la plataforma** con la cuenta de servicio del backend, y
	// de él cuelgan las integraciones que el proxy sirve. Cualquiera puede
	// crearse una org y ser su admin, así que esto no puede depender del rol en
	// la org: sólo superadmin (barrido de seguridad, 6-oct-2026).
	if req.Type == domain.ServerTypeKubernetes && !user.Superadmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "kubernetes-superadmin-only")
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
	// Ni convertirlo en kubernetes (ver CreateServer), ni cambiarle a dónde se
	// conecta siendo sólo miembro: con el host, el usuario o el puerto del
	// agente en otra máquina, la app de un admin mandaría ahí su SSH y sus
	// pases de agente. El nombre sí lo puede cambiar cualquier escritor.
	if (req.Type == domain.ServerTypeKubernetes || server.Type == domain.ServerTypeKubernetes) && req.Type != server.Type && !user.Superadmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "kubernetes-superadmin-only")
		return
	}
	cambiaConexion := req.Host != server.Host || req.SSHUser != server.SSHUser ||
		req.SSHPort != server.SSHPort || req.AgentPort != server.AgentPort
	if cambiaConexion && !user.Superadmin && role != domain.OrgRoleAdmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "connection-admin-only")
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
