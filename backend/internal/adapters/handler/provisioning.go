package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// ProvisioningHandler: las ejecuciones de playbooks y rotaciones que la app
// lanzó sobre un servidor. Ver `domain.ProvisioningRun`.
type ProvisioningHandler struct {
	servers *service.ServerService
	svc     *service.ProvisioningService
}

func NewProvisioningHandler(servers *service.ServerService, svc *service.ProvisioningService) *ProvisioningHandler {
	return &ProvisioningHandler{servers: servers, svc: svc}
}

// List: cualquiera de la org. Saber qué se le aplicó a una máquina es la
// mitad de entender por qué se comporta así.
func (h *ProvisioningHandler) List(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	runs, err := h.svc.List(server.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list runs", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ProvisioningRunResponse]{Success: true, Data: runs})
}

// Start: quien puede editar el servidor. Lanzar un playbook es cambiar la
// máquina, y es el mismo permiso que cambiar sus datos de conexión.
func (h *ProvisioningHandler) Start(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateRequest[domain.StartProvisioningRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	run, err := h.svc.Start(server, user.UserID, user.ViaToken, req)
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ProvisioningRun]{Success: true, Data: run})
}

// Finish: mismo permiso que abrirla. Cerrar una ya cerrada es 409: el primer
// cierre es el que cuenta, y uno tardío no puede reescribir cómo acabó.
func (h *ProvisioningHandler) Finish(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.FinishProvisioningRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	err = h.svc.Finish(server.ID, chi.URLParam(r, "rid"), req)
	switch {
	case errors.Is(err, repository.ErrProvisioningNotRunning):
		// Puede ser que ya se cerró, o que no es de este servidor: las dos
		// cosas se leen igual desde fuera, y no contar cuál es a propósito.
		SendErrorResponse(w, http.StatusConflict, "Run is not open", "provisioning-not-running")
		return
	case err != nil:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to finish run", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Recorded"})
}

// requestError traduce los errores del protocolo. Una autorización que no casa
// —gastada, caducada, de otro playbook o de otra versión— se lee igual desde
// fuera (409): no se cuenta cuál de las cosas falló.
func requestError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrBadRisk), errors.Is(err, domain.ErrBadPlaybookID),
		errors.Is(err, domain.ErrVerifyRequired), errors.Is(err, domain.ErrRollbackRequired),
		errors.Is(err, domain.ErrConfigSeqRequired), errors.Is(err, domain.ErrConfirmServerName),
		errors.Is(err, domain.ErrAcknowledgeFlags):
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
	case errors.Is(err, domain.ErrInPersonOnly), errors.Is(err, domain.ErrGrantRequired),
		errors.Is(err, domain.ErrNotYourRequest):
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", err.Error())
	case errors.Is(err, domain.ErrRequestNotFound), errors.Is(err, repository.ErrConfigVersionNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", err.Error())
	case errors.Is(err, domain.ErrRequestState), errors.Is(err, domain.ErrRequestExpired),
		errors.Is(err, domain.ErrGrantMismatch):
		SendErrorResponse(w, http.StatusConflict, "Conflict", err.Error())
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Provisioning request failed", err.Error())
	}
}

// Requests: las peticiones de ejecución del servidor, para cualquiera de la
// org (como el historial de ejecuciones).
func (h *ProvisioningHandler) Requests(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.Requests(server.ID)
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ProvisioningRequestResponse]{Success: true, Data: out})
}

func (h *ProvisioningHandler) GetRequest(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.GetRequest(server.ID, chi.URLParam(r, "rqid"))
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ProvisioningRequestResponse]{Success: true, Data: out})
}

// CreateRequest: pedir es del mismo permiso que lanzar (miembro). Pedir no
// cambia nada: abre una petición que espera su ensayo.
func (h *ProvisioningHandler) CreateRequest(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateStrictRequest[domain.CreateProvisioningRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.Request(server, user, req)
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ProvisioningRequest]{Success: true, Data: out})
}

// SubmitCheck: el ensayo, una vez por petición.
func (h *ProvisioningHandler) SubmitCheck(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	req, err := ValidateStrictRequest[domain.ProvisioningCheck](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.SubmitCheck(server, chi.URLParam(r, "rqid"), req)
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ProvisioningRequestResponse]{Success: true, Data: out})
}

// Discard: quitar una petición que se quedó sin ensayo. Quien la pidió (un
// miembro, o su agente con `servers:manage`) o un admin.
func (h *ProvisioningHandler) Discard(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	role, _ := user.RoleInOrg(server.OrgID)
	admin := user.Superadmin || role == domain.OrgRoleAdmin
	out, err := h.svc.Discard(server, user, admin, chi.URLParam(r, "rqid"))
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ProvisioningRequestResponse]{Success: true, Data: out})
}

// Reverify: volver a verificar una petición cuya verificación falló. Quien la
// pidió (un miembro, o su agente con `servers:manage`) o un admin.
func (h *ProvisioningHandler) Reverify(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	role, _ := user.RoleInOrg(server.OrgID)
	admin := user.Superadmin || role == domain.OrgRoleAdmin
	out, err := h.svc.Reverify(server, user, admin, chi.URLParam(r, "rqid"))
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ProvisioningRequestResponse]{Success: true, Data: out})
}

// Decide: de admin, como cambiar la conexión del servidor, y en persona.
// Ningún token llega aquí: la ruta no está en `patWritable`, y el servicio lo
// vuelve a mirar (`ViaToken`) por si algún día alguien la añadiera.
func (h *ProvisioningHandler) Decide(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateStrictRequest[domain.DecideProvisioningRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.Decide(server, user, chi.URLParam(r, "rqid"), req)
	if err != nil {
		requestError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ProvisioningRequestResponse]{Success: true, Data: out})
}
