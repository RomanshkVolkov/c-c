package handler

import (
	"errors"
	"html"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// maxWebhookBody: lo más que se lee de una entrega. Un push con veinte commits
// cabe holgado; más es alguien probando.
const maxWebhookBody = 1 << 20

type GitHubHandler struct{ svc *service.GitHubService }

func NewGitHubHandler(svc *service.GitHubService) *GitHubHandler { return &GitHubHandler{svc: svc} }

// scopeOrg: la org de la URL, sólo para sus miembros (404 para el resto).
func scopeOrg(w http.ResponseWriter, r *http.Request, min domain.OrgRole) (string, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return "", false
	}
	orgID := chi.URLParam(r, "id")
	role, member := user.RoleInOrg(orgID)
	if user.Superadmin {
		role, member = domain.OrgRoleAdmin, true
	}
	if !member {
		SendErrorResponse(w, http.StatusNotFound, "Organization not found", "not-found")
		return "", false
	}
	if !roleMeets(role, min) {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "insufficient-role")
		return "", false
	}
	return orgID, true
}

func (h *GitHubHandler) Status(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.Status(orgID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "GitHub status failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.GitHubStatusResponse]{Success: true, Data: out})
}

func (h *GitHubHandler) Link(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	u, err := h.svc.LinkURL(orgID)
	if err != nil {
		githubError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.GitHubLinkResponse]{Success: true, Data: &domain.GitHubLinkResponse{URL: u}})
}

func (h *GitHubHandler) UpdateRepo(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateGitHubRepoRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	repo, err := h.svc.LinkRepo(orgID, chi.URLParam(r, "repoId"), req)
	if err != nil {
		githubError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.GitHubRepo]{Success: true, Data: repo})
}

// LinkTaskPR: `POST /api/v1/tasks/{id}/git/prs` con `{url}`. Enlaza a mano una
// PR a la tarea. Un miembro de la org de la tarea (no un lector: añade una
// línea al hilo); a quien no es de la org, 404, como a una tarea que no existe.
func (h *GitHubHandler) LinkTaskPR(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	item, err := h.svc.Task(chi.URLParam(r, "id"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Task not found", "not-found")
		return
	}
	role, member := user.RoleInOrg(item.OrgID)
	if user.Superadmin {
		role, member = domain.OrgRoleAdmin, true
	}
	if !member {
		SendErrorResponse(w, http.StatusNotFound, "Task not found", "not-found")
		return
	}
	if !role.CanWrite() {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "insufficient-role")
		return
	}
	req, err := ValidateRequest[domain.LinkPRRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	link, err := h.svc.LinkPRByURL(item, req.URL)
	switch {
	case err == nil:
		SendResult(w, http.StatusOK, domain.APIResponse[*domain.TaskGitLink]{Success: true, Data: link})
	case errors.Is(err, service.ErrNotAPullURL):
		SendErrorResponse(w, http.StatusBadRequest, "That is not a GitHub pull request URL", "not-a-pull-url")
	case errors.Is(err, service.ErrRepoNotInOrg):
		SendErrorResponse(w, http.StatusUnprocessableEntity, "That repository is not connected to this organization", "repo-not-in-org")
	case errors.Is(err, service.ErrGitHubOff):
		SendErrorResponse(w, http.StatusServiceUnavailable, "GitHub is not configured", "github-off")
	default:
		// GitHub no la encontró, o no contestó: lo mismo para quien pega.
		SendErrorResponse(w, http.StatusBadGateway, "GitHub could not find that pull request", "pr-not-found")
	}
}

// Webhook: `POST /webhooks/github`, fuera del JWT. Quien llama es GitHub, y lo
// que lo prueba es la firma sobre los bytes crudos.
func (h *GitHubHandler) Webhook(w http.ResponseWriter, r *http.Request) {
	if !h.svc.Configured() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "GitHub is not configured", "github-off")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		SendErrorResponse(w, http.StatusRequestEntityTooLarge, "Payload too large", "payload-too-large")
		return
	}
	if !h.svc.VerifySignature(body, r.Header.Get("X-Hub-Signature-256")) {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "bad-signature")
		return
	}
	if err := h.svc.Handle(r.Header.Get("X-GitHub-Event"), body); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Webhook failed", "webhook-failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Setup: `GET /webhooks/github/setup`, adonde GitHub manda el **navegador** de
// quien instaló. Contesta una página corta, no JSON: es una persona leyendo.
func (h *GitHubHandler) Setup(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
	err := h.svc.Setup(id, r.URL.Query().Get("state"))
	switch {
	case err == nil:
		setupPage(w, http.StatusOK, "GitHub is linked to cac", "You can close this tab and go back to cac.")
	case errors.Is(err, repository.ErrInstallationTaken):
		setupPage(w, http.StatusConflict, "Already linked", "This GitHub installation is already linked to another cac organization.")
	case errors.Is(err, service.ErrGitHubOff):
		setupPage(w, http.StatusServiceUnavailable, "GitHub is not configured", "This cac server has no GitHub App set up.")
	default:
		setupPage(w, http.StatusBadRequest, "This link has expired", "Start again from cac: Organization settings → GitHub.")
	}
}

func setupPage(w http.ResponseWriter, code int, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, `<!doctype html><meta charset="utf-8"><title>cac</title>`+
		`<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">`+
		`<h1 style="font-size:1.25rem">`+html.EscapeString(title)+`</h1><p>`+html.EscapeString(body)+`</p></body>`)
}

func githubError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrGitHubOff):
		SendErrorResponse(w, http.StatusServiceUnavailable, "GitHub is not configured", "github-off")
	case errors.Is(err, service.ErrSpaceOutsideOrg):
		SendErrorResponse(w, http.StatusBadRequest, "That space is not in this organization", "space-outside-org")
	case errors.Is(err, gorm.ErrRecordNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "GitHub failed", err.Error())
	}
}
