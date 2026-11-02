package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// IncidentHandler: el registro de lo que mordió (domain.Incident).
//
// Quien no es de la org de un incidente recibe 404, nunca 403, como en el
// resto: confirmar que existe ya sería contar algo.
type IncidentHandler struct {
	svc     *service.IncidentService
	docs    *service.DocService
	servers *service.ServerService
}

func NewIncidentHandler(svc *service.IncidentService, docs *service.DocService, servers *service.ServerService) *IncidentHandler {
	return &IncidentHandler{svc: svc, docs: docs, servers: servers}
}

// incidentList es la respuesta de una lista: los incidentes, y si había más.
type incidentList struct {
	Incidents []domain.IncidentSummary `json:"incidents"`
	Truncated bool                     `json:"truncated,omitempty"`
}

// Record apunta uno en el nodo: POST /api/v1/docs/{kind}/{ownerId}/incidents.
func (h *IncidentHandler) Record(w http.ResponseWriter, r *http.Request) {
	kind, id := chi.URLParam(r, "kind"), chi.URLParam(r, "ownerId")
	if !domain.ValidDocOwnerKind(kind) {
		SendErrorResponse(w, http.StatusBadRequest, "Unknown document owner", "bad-kind")
		return
	}
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	orgID, err := h.docs.OwnerOrg(domain.DocOwnerKind(kind), id)
	if err != nil || !memberOf(user, orgID) {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	req, err := ValidateRequest[domain.IncidentRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	in, err := h.svc.Record(orgID, domain.DocOwnerKind(kind), id, user.UserID, domain.ViaFrom(r.Context()), req)
	if err != nil {
		h.fail(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.Incident]{Success: true, Data: in})
}

// Get: GET /api/v1/incidents/{id}, entero.
func (h *IncidentHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, ok := h.scope(w, r)
	if !ok {
		return
	}
	in, err := h.svc.Get(id)
	if err != nil {
		h.fail(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Incident]{Success: true, Data: in})
}

// Add: POST /api/v1/incidents/{id}/additions. Sólo añade.
func (h *IncidentHandler) Add(w http.ResponseWriter, r *http.Request) {
	id, ok := h.scope(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.IncidentAdditions](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	org, _ := h.svc.OrgOf(id)
	in, err := h.svc.Add(org, id, req)
	if err != nil {
		h.fail(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Incident]{Success: true, Data: in})
}

// SetStatus: PATCH /api/v1/incidents/{id} con `status`.
func (h *IncidentHandler) SetStatus(w http.ResponseWriter, r *http.Request) {
	id, ok := h.scope(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.IncidentStatusPatch](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	in, err := h.svc.SetStatus(id, domain.IncidentStatus(req.Status))
	if err != nil {
		h.fail(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Incident]{Success: true, Data: in})
}

// List: GET /api/v1/incidents?orgId=&spaceId=&server=&area=&status=&since=&limit=.
//
// Sin `orgId`, en las organizaciones de las que el token es **miembro**, como
// la búsqueda: lo que sale va al contexto de un agente, y ser superadmin no
// tiene que traerle lo de otra org.
func (h *IncidentHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	q := r.URL.Query()
	f := domain.IncidentFilter{
		SpaceID: strings.TrimSpace(q.Get("spaceId")),
		Node:    strings.TrimSpace(q.Get("node")),
		Server:  strings.TrimSpace(q.Get("server")),
		Area:    strings.TrimSpace(q.Get("area")),
		Status:  strings.TrimSpace(q.Get("status")),
	}
	if f.Status != "" && !domain.ValidIncidentStatus(f.Status) {
		SendErrorResponse(w, http.StatusBadRequest, "status is open or fixed", "bad-status")
		return
	}
	if s := strings.TrimSpace(q.Get("since")); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "since must be an RFC 3339 instant", "bad-since")
			return
		}
		f.Since = &t
	}
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	if org := strings.TrimSpace(q.Get("orgId")); org != "" {
		if !memberOf(user, org) {
			SendResult(w, http.StatusOK, domain.APIResponse[incidentList]{Success: true, Data: incidentList{Incidents: []domain.IncidentSummary{}}})
			return
		}
		f.OrgIDs = []string{org}
	} else {
		f.OrgIDs = MemberOrgs(user)
	}
	h.list(w, f)
}

// ForServer: GET /api/v1/servers/{id}/incidents, los de un servidor, abiertos
// primero. Es lo que se enseña en su pantalla y lo que el MCP le pone delante
// a un agente que va a tocarlo.
func (h *IncidentHandler) ForServer(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	h.list(w, domain.IncidentFilter{OrgIDs: []string{server.OrgID}, Server: server.ID})
}

func (h *IncidentHandler) list(w http.ResponseWriter, f domain.IncidentFilter) {
	out, truncated, err := h.svc.List(f)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list incidents", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[incidentList]{Success: true, Data: incidentList{Incidents: out, Truncated: truncated}})
}

// scope: el id de la ruta, si quien pregunta es de su org.
func (h *IncidentHandler) scope(w http.ResponseWriter, r *http.Request) (string, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return "", false
	}
	id := chi.URLParam(r, "id")
	org, err := h.svc.OrgOf(id)
	if err != nil || !memberOf(user, org) {
		SendErrorResponse(w, http.StatusNotFound, "Incident not found", "not-found")
		return "", false
	}
	return id, true
}

func (h *IncidentHandler) fail(w http.ResponseWriter, err error) {
	var noServer *service.ErrNoSuchServer
	var badCommit *service.ErrBadCommit
	switch {
	case errors.Is(err, service.ErrIncidentNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Incident not found", "not-found")
	case errors.Is(err, service.ErrIncidentOriginNotHere):
		SendErrorResponse(w, http.StatusBadRequest, err.Error(), "incident-origin-not-here")
	case errors.Is(err, service.ErrIncidentSupersedesNotHere):
		SendErrorResponse(w, http.StatusBadRequest, err.Error(), "incident-supersedes-not-here")
	case errors.Is(err, service.ErrIncidentAlreadySuperseded):
		SendErrorResponse(w, http.StatusBadRequest, err.Error(), "incident-already-superseded")
	case errors.Is(err, service.ErrIncidentNothingToAdd):
		SendErrorResponse(w, http.StatusBadRequest, "Pass servers, areas, commits or guards to add", "incident-nothing-to-add")
	case errors.As(err, &noServer):
		SendErrorResponse(w, http.StatusBadRequest, noServer.Error(), "no-such-server")
	case errors.As(err, &badCommit):
		SendErrorResponse(w, http.StatusBadRequest, badCommit.Error(), "bad-commit")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Incident failed", err.Error())
	}
}

// memberOf: si es de esa org, o superadmin.
func memberOf(user *domain.ClaimsJWT, orgID string) bool {
	if orgID == "" {
		return false
	}
	if user.Superadmin {
		return true
	}
	_, member := user.RoleInOrg(orgID)
	return member
}
