package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// ServerConfigHandler: la config versionada de un servidor y las plantillas
// de la org. Leer es de cualquiera de la org; escribir, de admin, como la
// conexión de un servidor o los secrets de un servicio: decide qué se monta en
// una máquina y de dónde salen sus credenciales. Un token puede escribir con
// `servers:manage`, pero ninguna de estas rutas corre nada: aplicar es de una
// persona (ver `middleware.TestATokenConfiguresButNeverDeploys`).
type ServerConfigHandler struct {
	servers *service.ServerService
	svc     *service.ServerConfigService
}

func NewServerConfigHandler(servers *service.ServerService, svc *service.ServerConfigService) *ServerConfigHandler {
	return &ServerConfigHandler{servers: servers, svc: svc}
}

func configError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrBadVarName), errors.Is(err, domain.ErrSecretInVars),
		errors.Is(err, domain.ErrBadPlaybookID), errors.Is(err, domain.ErrConfigTooLarge),
		errors.Is(err, domain.ErrPerServerNotReq), errors.Is(err, domain.ErrBadConfigRef),
		errors.Is(err, domain.ErrBadConfigSecret), errors.Is(err, service.ErrNothingToCopy),
		errors.Is(err, service.ErrTooManyRefs):
		SendErrorResponse(w, http.StatusBadRequest, "Invalid configuration", err.Error())
	case errors.Is(err, repository.ErrServerTemplateNotFound), errors.Is(err, repository.ErrConfigVersionNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", err.Error())
	case errors.Is(err, repository.ErrTemplateNameTaken):
		SendErrorResponse(w, http.StatusConflict, "Name taken", err.Error())
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Server configuration failed", err.Error())
	}
}

// Config: la actual y la lista de versiones.
func (h *ServerConfigHandler) Config(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.Summary(server.ID)
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ServerConfigSummary]{Success: true, Data: out})
}

// Version: una versión entera, por su número.
func (h *ServerConfigHandler) Version(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	seq, err := strconv.Atoi(chi.URLParam(r, "seq"))
	if err != nil || seq < 1 {
		SendErrorResponse(w, http.StatusNotFound, "Not found", repository.ErrConfigVersionNotFound.Error())
		return
	}
	v, err := h.svc.Version(server.ID, seq)
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ServerConfigVersion]{Success: true, Data: v})
}

// Effective: lo que se aplicaría con la actual, o con `?seq=N`.
func (h *ServerConfigHandler) Effective(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	seq := 0
	if q := r.URL.Query().Get("seq"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "bad-seq")
			return
		}
		seq = n
	}
	eff, err := h.svc.Effective(server, seq)
	if err != nil {
		configError(w, err)
		return
	}
	if seq > 0 && eff.ConfigSeq == 0 {
		configError(w, repository.ErrConfigVersionNotFound)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.EffectiveConfig]{Success: true, Data: eff})
}

// Save guarda una versión nueva. Estricto: un campo que el tipo no conoce
// (un `secrets`, un `values`) se rechaza en vez de descartarse.
func (h *ServerConfigHandler) Save(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateStrictRequest[domain.PutServerConfigRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "invalid-body")
		return
	}
	v, err := h.svc.Save(server, user, req)
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ServerConfigVersion]{Success: true, Data: v})
}

// ─── Plantillas ───────────────────────────────────────────────────────────────

func (h *ServerConfigHandler) Templates(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.Templates(orgID)
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ServerTemplateResponse]{Success: true, Data: out})
}

type serverTemplateDetail struct {
	domain.ServerTemplate
	Versions []domain.ServerTemplateVersionResponse `json:"versions"`
}

func (h *ServerConfigHandler) Template(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	t, vs, err := h.svc.Template(orgID, chi.URLParam(r, "tplId"))
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[serverTemplateDetail]{Success: true, Data: serverTemplateDetail{ServerTemplate: *t, Versions: vs}})
}

func (h *ServerConfigHandler) CreateTemplate(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateStrictRequest[domain.CreateServerTemplateRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "invalid-body")
		return
	}
	out, err := h.svc.CreateTemplate(orgID, user, req)
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ServerTemplateResponse]{Success: true, Data: out})
}

func (h *ServerConfigHandler) SaveTemplate(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateStrictRequest[domain.PutServerTemplateRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "invalid-body")
		return
	}
	v, err := h.svc.SaveTemplate(orgID, chi.URLParam(r, "tplId"), user, req)
	if err != nil {
		configError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ServerTemplateVersion]{Success: true, Data: v})
}
