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
	run, err := h.svc.Start(server, user.UserID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to start run", err.Error())
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
