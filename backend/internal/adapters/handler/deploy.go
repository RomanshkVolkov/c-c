package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// DeployHandler: los servicios que cac sabe desplegar en un servidor, y sus
// despliegues. Ver `domain.Deployable`.
type DeployHandler struct {
	servers *service.ServerService
	svc     *service.DeployService
	limiter *ingestLimiter
	secrets *service.SecretRefService
}

func NewDeployHandler(servers *service.ServerService, svc *service.DeployService) *DeployHandler {
	return &DeployHandler{servers: servers, svc: svc, limiter: newIngestLimiter()}
}

// WithSecrets: las referencias a 1Password de cada servicio (R8).
func (h *DeployHandler) WithSecrets(s *service.SecretRefService) *DeployHandler {
	h.secrets = s
	return h
}

// SecretRefs: las referencias del servicio. Las ve cualquiera de la org: son
// sólo nombres y dónde vive cada valor.
func (h *DeployHandler) SecretRefs(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.secrets.List(d)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DeployableSecretRef]{Success: true, Data: out})
}

// PutSecretRefs reemplaza la lista. Admin: decide de dónde salen las
// credenciales de producción.
func (h *DeployHandler) PutSecretRefs(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := ValidateStrictRequest[domain.PutSecretRefsRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "invalid-body")
		return
	}
	out, err := h.secrets.Replace(d, req)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DeployableSecretRef]{Success: true, Data: out})
}

func (h *DeployHandler) SecretRotations(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.secrets.ListRotations(d)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.SecretRotationResponse]{Success: true, Data: out})
}

// RecordRotation apunta una rotación ya hecha desde la app. Member, como
// desplegar: rotar es llevar al servidor lo que dicen las referencias.
func (h *DeployHandler) RecordRotation(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleMember)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateStrictRequest[domain.RecordRotationRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "invalid-body")
		return
	}
	out, err := h.secrets.RecordRotation(d, user.UserID, req)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.SecretRotation]{Success: true, Data: out})
}

// deployable carga el deployable de la URL, sólo si es de ese servidor.
func (h *DeployHandler) deployable(w http.ResponseWriter, r *http.Request, min domain.OrgRole) (*domain.Deployable, bool) {
	server, ok := scopeServer(w, r, h.servers, min)
	if !ok {
		return nil, false
	}
	d, err := h.svc.FindDeployable(server.ID, chi.URLParam(r, "did"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Deployable not found", "not-found")
		return nil, false
	}
	return d, true
}

func (h *DeployHandler) List(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.ListDeployables(server.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.Deployable]{Success: true, Data: out})
}

// Create registra un servicio como desplegable. Member: no toca el servidor,
// sólo le enseña a cac qué hay ahí.
func (h *DeployHandler) Create(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleMember)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateDeployableRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	d, err := h.svc.CreateDeployable(server, req)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.Deployable]{Success: true, Data: d})
}

func (h *DeployHandler) Update(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleMember)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateDeployableRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.UpdateDeployable(d, req)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Deployable]{Success: true, Data: out})
}

// Delete: admin, porque se lleva el historial.
func (h *DeployHandler) Delete(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	if err := h.svc.DeleteDeployable(d.ServerID, d.ID); err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Deleted"})
}

// Deploy encola el despliegue de un commit. 202: lo hace el agente, en su
// siguiente pregunta; lo que se ve después llega por el stream de eventos.
func (h *DeployHandler) Deploy(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleMember)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.DeployRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	dep, _, err := h.svc.RequestDeploy(d, domain.DeployByUser, user.UserID, req.Sha, "")
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusAccepted, domain.APIResponse[*domain.Deployment]{Success: true, Data: dep})
}

func (h *DeployHandler) Deployments(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.ListDeployments(d.ID)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DeploymentSummary]{Success: true, Data: out})
}

// Deployment: uno, con su log.
func (h *DeployHandler) Deployment(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	dep, err := h.svc.FindDeployment(d.ID, chi.URLParam(r, "depId"))
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Deployment]{Success: true, Data: dep})
}

func (h *DeployHandler) Rollback(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleMember)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	dep, err := h.svc.Rollback(d, chi.URLParam(r, "depId"), user.UserID)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusAccepted, domain.APIResponse[*domain.Deployment]{Success: true, Data: dep})
}

// CIKey acuña la llave del CI de este servicio. Admin: con ella, alguien de
// fuera puede encolar deploys (en modo `deploy`).
func (h *DeployHandler) CIKey(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	res, err := h.svc.MintCIKey(d)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CIKeyResponse]{Success: true, Data: res})
}

func (h *DeployHandler) Builds(w http.ResponseWriter, r *http.Request) {
	d, ok := h.deployable(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.ListBuilds(d.ID)
	if err != nil {
		deployError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ImageBuild]{Success: true, Data: out})
}

// DeployIngest es la entrada del CI: `POST /ingest/v1/deploys` con
// `X-Deploy-Key`. Fuera del JWT, como la de reportes: quien llama es un
// workflow, no una persona. Una llave que no casa es un 401 sin más detalle.
func (h *DeployHandler) DeployIngest(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("X-Deploy-Key")
	if !strings.HasPrefix(key, repository.DeployKeyPrefix) {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-deploy-key")
		return
	}
	d, err := h.svc.DeployableByCIKey(key)
	if err != nil {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-deploy-key")
		return
	}
	// Por deployable: un CI que se vuelve loco no puede llenar la tabla.
	if !h.limiter.allow(d.ID, 60) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many notices", "rate-limited")
		return
	}
	req, err := ValidateRequest[domain.DeployNotice](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	res, err := h.svc.Notice(d, req, "ci")
	if err != nil {
		deployError(w, err)
		return
	}
	code := http.StatusOK
	if res.Deploy == "queued" {
		code = http.StatusAccepted
	}
	SendResult(w, code, domain.APIResponse[*domain.DeployNoticeResponse]{Success: true, Data: res})
}

func deployError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repository.ErrDeployInFlight):
		SendErrorResponse(w, http.StatusConflict, "A deploy is already queued or running for this service", "deploy-in-flight")
	case errors.Is(err, service.ErrAgentTooOld):
		SendErrorResponse(w, http.StatusConflict, "This server's agent is too old to deploy; reinstall it", "agent-too-old")
	case errors.Is(err, service.ErrNothingToRollBackTo):
		SendErrorResponse(w, http.StatusConflict, "There is nothing before this deploy to go back to", "nothing-to-roll-back-to")
	case errors.Is(err, service.ErrRollbackOutsideRepo):
		SendErrorResponse(w, http.StatusBadRequest, "The previous image is not from this service's repository", "rollback-outside-repo")
	case errors.Is(err, service.ErrBadSha):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a commit sha", "bad-sha")
	case errors.Is(err, service.ErrBadImageRepo):
		SendErrorResponse(w, http.StatusBadRequest, "That is not an image repository", "bad-image-repo")
	case errors.Is(err, service.ErrBadServiceName):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a stack or service name", "bad-service-name")
	case errors.Is(err, service.ErrBadSecretName):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a secret name", "bad-secret-name")
	case errors.Is(err, service.ErrBadOpRef):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a 1Password reference", "bad-op-ref")
	case errors.Is(err, service.ErrDuplicateName):
		SendErrorResponse(w, http.StatusBadRequest, "That secret name is repeated", "duplicate-secret-name")
	case errors.Is(err, service.ErrBadDockerName):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a cac secret name", "bad-docker-secret-name")
	case errors.Is(err, service.ErrRotationNeedsDeploy):
		SendErrorResponse(w, http.StatusConflict, "Secrets go through cac only when cac deploys this service", "rotation-needs-deploy")
	case errors.Is(err, service.ErrBadRepoName):
		SendErrorResponse(w, http.StatusBadRequest, "That is not an owner/name repository", "bad-repo-name")
	case errors.Is(err, service.ErrBadWorkflow):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a workflow file name", "bad-workflow")
	case errors.Is(err, service.ErrDeployNotSwarm):
		SendErrorResponse(w, http.StatusBadRequest, "Only swarm servers deploy from cac", "deploy-needs-swarm")
	case errors.Is(err, gorm.ErrRecordNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Deploy failed", err.Error())
	}
}
