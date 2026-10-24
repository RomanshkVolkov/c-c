package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// BackupHandler: los backups de las bases de un servidor (#166). Ver
// `service.BackupService`. Leer es de cualquiera de la organización;
// configurar, lanzar, descargar y tocar las llaves, de un admin.
type BackupHandler struct {
	servers *service.ServerService
	svc     *service.BackupService
}

func NewBackupHandler(servers *service.ServerService, svc *service.BackupService) *BackupHandler {
	return &BackupHandler{servers: servers, svc: svc}
}

func backupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
	case errors.Is(err, repository.ErrBackupInFlight):
		SendErrorResponse(w, http.StatusConflict, "A backup of this database is already running", err.Error())
	case errors.Is(err, repository.ErrBackupNotRunning):
		SendErrorResponse(w, http.StatusConflict, "That backup is not running here", err.Error())
	case errors.Is(err, service.ErrAgentTooOldForUsername):
		SendErrorResponse(w, http.StatusConflict, "Update the server's agent to use a fixed username", err.Error())
	case errors.Is(err, service.ErrNoRecipient):
		SendErrorResponse(w, http.StatusConflict, "Add the organization's age public key first", err.Error())
	case errors.Is(err, service.ErrBadRecipient):
		SendErrorResponse(w, http.StatusBadRequest, "Not an age public key", err.Error())
	case errors.Is(err, service.ErrNothingToTest):
		SendErrorResponse(w, http.StatusConflict, "There is no successful backup to use", err.Error())
	case errors.Is(err, service.ErrBackupsDisabled):
		SendErrorResponse(w, http.StatusServiceUnavailable, "Backups are not configured on this server", err.Error())
	case errors.Is(err, service.ErrNotABackupJob):
		SendErrorResponse(w, http.StatusConflict, "Wrong job kind for this call", err.Error())
	default:
		SendErrorResponse(w, http.StatusBadRequest, "Invalid backup request", err.Error())
	}
}

// Status: si los backups están encendidos y si el agente de este servidor sabe
// hacerlos, para que la pestaña lo diga antes de que alguien configure nada.
func (h *BackupHandler) Status(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	keys, err := h.svc.Recipients(server.OrgID)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]any]{Success: true, Data: map[string]any{
		"enabled":       h.svc.Enabled(),
		"agentReady":    server.AgentVersion >= domain.AgentVersionBackups,
		"agentVersion":  server.AgentVersion,
		"minAgent":      domain.AgentVersionBackups,
		"hasRecipients": len(keys) > 0,
		"everyHours":    domain.BackupEveryHours,
	}})
}

func (h *BackupHandler) ListTargets(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.ListTargets(server.ID)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.BackupTarget]{Success: true, Data: out})
}

func (h *BackupHandler) CreateTarget(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.BackupTargetRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	t, err := h.svc.CreateTarget(server, req)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.BackupTarget]{Success: true, Data: t})
}

func (h *BackupHandler) UpdateTarget(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.BackupTargetRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	t, err := h.svc.UpdateTarget(server, chi.URLParam(r, "tid"), req)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.BackupTarget]{Success: true, Data: t})
}

func (h *BackupHandler) DeleteTarget(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	if err := h.svc.DeleteTarget(server.ID, chi.URLParam(r, "tid")); err != nil {
		backupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *BackupHandler) RunNow(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	b, err := h.svc.RunNow(server.ID, chi.URLParam(r, "tid"), user.UserID)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusAccepted, domain.APIResponse[*domain.Backup]{Success: true, Data: b})
}

func (h *BackupHandler) TestNow(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	b, err := h.svc.TestNow(server.ID, chi.URLParam(r, "tid"), user.UserID)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusAccepted, domain.APIResponse[*domain.Backup]{Success: true, Data: b})
}

func (h *BackupHandler) History(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := h.svc.History(server.ID, chi.URLParam(r, "tid"), limit)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.Backup]{Success: true, Data: out})
}

// Backup: uno, con su log.
func (h *BackupHandler) Backup(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	b, err := h.svc.Backup(server.ID, chi.URLParam(r, "bid"))
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Backup]{Success: true, Data: b})
}

// Download: una URL de cinco minutos al fichero **cifrado**. Admin: aunque
// sin la llave no se puede leer, quién se lleva una copia de la base de un
// cliente es una decisión, no un clic de cualquiera.
func (h *BackupHandler) Download(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := h.svc.DownloadURL(r.Context(), server.ID, chi.URLParam(r, "bid"))
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PresignedRequest]{Success: true, Data: req})
}

func (h *BackupHandler) Recipients(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	out, err := h.svc.Recipients(server.OrgID)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.BackupRecipient]{Success: true, Data: out})
}

func (h *BackupHandler) AddRecipient(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.BackupRecipientRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	rc, err := h.svc.AddRecipient(server.OrgID, req)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.BackupRecipient]{Success: true, Data: rc})
}

func (h *BackupHandler) DeleteRecipient(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	if err := h.svc.DeleteRecipient(server.OrgID, chi.URLParam(r, "rid")); err != nil {
		backupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── El agente ────────────────────────────────────────────────────────────────

func (h *AgentHandler) backupServer(w http.ResponseWriter, r *http.Request) (*domain.Server, bool) {
	server, ok := AgentServer(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-agent")
		return nil, false
	}
	if h.backups == nil {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Backups are not configured", service.ErrBackupsDisabled.Error())
		return nil, false
	}
	return server, true
}

func (h *AgentHandler) BackupLog(w http.ResponseWriter, r *http.Request) {
	server, ok := h.backupServer(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.AgentLogRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.backups.AppendLog(server.ID, chi.URLParam(r, "bid"), req.Lines); err != nil {
		backupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *AgentHandler) BackupUploadURL(w http.ResponseWriter, r *http.Request) {
	server, ok := h.backupServer(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.AgentUploadURLRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.backups.UploadURL(r.Context(), server.ID, chi.URLParam(r, "bid"), req)
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PresignedRequest]{Success: true, Data: out})
}

func (h *AgentHandler) BackupDownloadURL(w http.ResponseWriter, r *http.Request) {
	server, ok := h.backupServer(w, r)
	if !ok {
		return
	}
	out, err := h.backups.DownloadURLForAgent(r.Context(), server.ID, chi.URLParam(r, "bid"))
	if err != nil {
		backupError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PresignedRequest]{Success: true, Data: out})
}

func (h *AgentHandler) BackupFinish(w http.ResponseWriter, r *http.Request) {
	server, ok := h.backupServer(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.AgentBackupFinishRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.backups.Finish(server.ID, chi.URLParam(r, "bid"), req); err != nil {
		backupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RestoreKey: el agente manda la parte pública de la llave de restauración
// que generó para este servidor. La privada se queda en el host.
func (h *AgentHandler) RestoreKey(w http.ResponseWriter, r *http.Request) {
	server, ok := h.backupServer(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[struct {
		PublicKey string `json:"publicKey" validate:"required,max=80"`
	}](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.backups.SetRestoreKey(server, req.PublicKey); err != nil {
		backupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
