package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// CallHandler: invitar a gente de fuera a una llamada (W3).
//
// Dos mitades con puertas distintas. La de los miembros va detrás del JWT y de
// `authorizeOrg`, como todo. La pública no tiene JWT —quien entra no tiene
// cuenta— y lo único que la abre es el enlace firmado; por eso va con su propio
// límite de peticiones, y por eso es la única que contesta sin saber quién
// pregunta.
type CallHandler interface {
	Create(http.ResponseWriter, *http.Request)
	List(http.ResponseWriter, *http.Request)
	Get(http.ResponseWriter, *http.Request)
	Revoke(http.ResponseWriter, *http.Request)
	Token(http.ResponseWriter, *http.Request)
	Kick(http.ResponseWriter, *http.Request)
	RecordingPolicy(http.ResponseWriter, *http.Request)
	StartRecording(http.ResponseWriter, *http.Request)

	PublicInspect(http.ResponseWriter, *http.Request)
	PublicJoin(http.ResponseWriter, *http.Request)
}

type callHandler struct {
	svc     *service.CallInviteService
	rec     *service.RecordingService
	voice   *service.VoiceService
	spaces  SpaceFinder
	limiter *ingestLimiter
}

func NewCallHandler(svc *service.CallInviteService, rec *service.RecordingService,
	voice *service.VoiceService, spaces SpaceFinder) CallHandler {
	return &callHandler{svc: svc, rec: rec, voice: voice, spaces: spaces, limiter: newIngestLimiter()}
}

// Cuántas veces por hora se puede tocar la puerta pública. Por IP, para quien
// prueba enlaces a ciegas; y por invitación, para que un enlace filtrado no se
// convierta en cien personas entrando por turnos.
const (
	publicCallPerIPPerHour     = 60
	publicCallPerInvitePerHour = 120
)

// ─── Miembros ────────────────────────────────────────────────────────────────

// Create abre una invitación. Escribir en la organización, y si cuelga de un
// canal, que el canal sea de esa organización: si no, una invitación de mi org
// grabaría en el canal de otra.
func (h *callHandler) Create(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.CreateCallInviteRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, ok := authorizeOrg(w, r, req.OrgID, true)
	if !ok {
		return
	}
	var spaceID *string
	if req.SpaceID != "" {
		sp, err := h.spaces.FindSpace(req.SpaceID)
		if err != nil || sp.OrgID != req.OrgID {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return
		}
		spaceID = &sp.ID
	}
	inv, err := h.svc.Create(req.OrgID, spaceID, user.UserID, req.Title, req.TTLHours, req.MaxGuests)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create the invite", err.Error())
		return
	}
	out := h.svc.Describe(r.Context(), inv)
	SendResult(w, http.StatusCreated, domain.APIResponse[domain.CallInviteResponse]{Success: true, Data: out})
}

func (h *callHandler) List(w http.ResponseWriter, r *http.Request) {
	orgID := r.URL.Query().Get("orgId")
	if _, ok := authorizeOrg(w, r, orgID, false); !ok {
		return
	}
	out, err := h.svc.List(r.Context(), orgID, r.URL.Query().Get("spaceId"))
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list invites", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.CallInviteResponse]{Success: true, Data: out})
}

// invite resuelve la invitación y comprueba la pertenencia. **404 antes que
// 403**, como `authorizeOrg`: a quien no es de la organización no se le
// confirma que esa reunión existe.
func (h *callHandler) invite(w http.ResponseWriter, r *http.Request, needWrite bool) (*domain.CallInvite, *domain.ClaimsJWT, bool) {
	inv, err := h.svc.Find(chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, repository.ErrCallInviteNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return nil, nil, false
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the invite", err.Error())
		return nil, nil, false
	}
	user, ok := authorizeOrg(w, r, inv.OrgID, needWrite)
	if !ok {
		return nil, nil, false
	}
	return inv, user, true
}

func (h *callHandler) Get(w http.ResponseWriter, r *http.Request) {
	inv, _, ok := h.invite(w, r, false)
	if !ok {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.CallInviteResponse]{
		Success: true, Data: h.svc.Describe(r.Context(), inv),
	})
}

// Revoke: quien la creó o quien administra la organización. Otro miembro puede
// entrar y echar a un invitado, pero cerrar la reunión de un compañero no.
func (h *callHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	inv, user, ok := h.invite(w, r, true)
	if !ok {
		return
	}
	role, _ := user.RoleInOrg(inv.OrgID)
	if inv.CreatedBy != user.UserID && !user.Superadmin && role != domain.OrgRoleAdmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-the-host")
		return
	}
	if err := h.svc.Revoke(r.Context(), inv); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to revoke the invite", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

// Token: la entrada de un miembro a la reunión. Cualquier miembro, también los
// que sólo leen: entrar a una llamada es lo mismo que entrar al canal.
func (h *callHandler) Token(w http.ResponseWriter, r *http.Request) {
	inv, user, ok := h.invite(w, r, false)
	if !ok {
		return
	}
	if !h.voice.Configured() {
		SendErrorResponse(w, http.StatusNotImplemented,
			"Voice is not configured on this server", "voice-unconfigured")
		return
	}
	out, err := h.svc.MemberToken(inv, user.UserID, user.Username)
	if err != nil {
		callError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.MeetTokenResponse]{Success: true, Data: out})
}

// Kick saca a un invitado. Cualquier miembro que escriba: quien está en la
// llamada cuando alguien de fuera molesta no tiene por qué esperar a un admin.
func (h *callHandler) Kick(w http.ResponseWriter, r *http.Request) {
	inv, user, ok := h.invite(w, r, true)
	if !ok {
		return
	}
	if err := h.svc.Kick(r.Context(), inv, user.UserID, chi.URLParam(r, "identity")); err != nil {
		callError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

// RecordingPolicy: lo mismo que la del canal, para la sala de la reunión.
func (h *callHandler) RecordingPolicy(w http.ResponseWriter, r *http.Request) {
	inv, _, ok := h.invite(w, r, false)
	if !ok {
		return
	}
	if _, err := h.svc.RecordingTarget(inv); err != nil {
		SendResult(w, http.StatusOK, domain.APIResponse[*domain.RecordingPolicy]{
			Success: true, Data: &domain.RecordingPolicy{Enabled: false, Reason: err.Error()},
		})
		return
	}
	pol, err := h.rec.PolicyForRoom(inv.Room())
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to read the policy", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.RecordingPolicy]{Success: true, Data: pol})
}

// StartRecording graba la reunión. Parar, ver y borrar van por las rutas de
// siempre (`/recordings/{id}`), que autorizan por el canal del que cuelga.
func (h *callHandler) StartRecording(w http.ResponseWriter, r *http.Request) {
	inv, user, ok := h.invite(w, r, true)
	if !ok {
		return
	}
	target, err := h.svc.RecordingTarget(inv)
	if err != nil {
		callError(w, err)
		return
	}
	if !h.rec.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable,
			"Recording is not enabled on this server", "recordings-disabled")
		return
	}
	rec, err := h.rec.StartIn(r.Context(), target, user.UserID)
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrAlreadyRecording):
			SendErrorResponse(w, http.StatusConflict, "This call is already being recorded", "already-recording")
		case errors.Is(err, service.ErrRoomEmpty):
			SendErrorResponse(w, http.StatusConflict, "There is nobody in this call", "room-empty")
		default:
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to start recording", err.Error())
		}
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.Recording]{Success: true, Data: rec})
}

// ─── La puerta pública ───────────────────────────────────────────────────────

// El token viaja en el cuerpo de un POST y no en la ruta: una URL acaba en los
// logs del Gateway y de cualquier proxy del camino, y este token abre una
// reunión.

func (h *callHandler) PublicInspect(w http.ResponseWriter, r *http.Request) {
	req, ok := h.publicRequest(w, r)
	if !ok {
		return
	}
	out, err := h.svc.Inspect(req.Token)
	if err != nil {
		callError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PublicCallInvite]{Success: true, Data: out})
}

func (h *callHandler) PublicJoin(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.GuestJoinRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if !h.allow(w, r, req.Token) {
		return
	}
	if !h.voice.Configured() {
		SendErrorResponse(w, http.StatusNotImplemented,
			"Voice is not configured on this server", "voice-unconfigured")
		return
	}
	out, err := h.svc.JoinAsGuest(req.Token, req.Name, req.Pass)
	if err != nil {
		callError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.GuestJoinResponse]{Success: true, Data: out})
}

func (h *callHandler) publicRequest(w http.ResponseWriter, r *http.Request) (*domain.PublicCallRequest, bool) {
	req, err := ValidateRequest[domain.PublicCallRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return nil, false
	}
	return &req, h.allow(w, r, req.Token)
}

// allow: el límite de la puerta pública, por IP y por invitación.
func (h *callHandler) allow(w http.ResponseWriter, r *http.Request, token string) bool {
	ok := h.limiter.allow("ip:"+clientIP(r), publicCallPerIPPerHour)
	if ok {
		if id, valid := repository.VerifyCallInviteLink(token); valid {
			ok = h.limiter.allow("invite:"+id, publicCallPerInvitePerHour)
		}
	}
	if !ok {
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many requests", "rate-limited")
	}
	return ok
}

// callError traduce los errores del servicio a lo que la pantalla sabe decir.
func callError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrInviteInvalid):
		SendErrorResponse(w, http.StatusNotFound, "This link does not open any call", "invite-invalid")
	case errors.Is(err, service.ErrInviteExpired):
		SendErrorResponse(w, http.StatusGone, "This invite has expired", "invite-expired")
	case errors.Is(err, service.ErrInviteRevoked):
		SendErrorResponse(w, http.StatusGone, "This invite was revoked", "invite-revoked")
	case errors.Is(err, repository.ErrCallInviteFull):
		SendErrorResponse(w, http.StatusConflict, "This invite is full", "invite-full")
	case errors.Is(err, service.ErrGuestRemoved):
		SendErrorResponse(w, http.StatusForbidden, "You were removed from this call", "guest-removed")
	case errors.Is(err, service.ErrGuestName):
		SendErrorResponse(w, http.StatusBadRequest, "A name is required", "guest-name-required")
	case errors.Is(err, service.ErrOnlyGuests):
		SendErrorResponse(w, http.StatusForbidden, "Only guests can be removed", "kick-member-not-allowed")
	case errors.Is(err, service.ErrRecordingNeedsSpace):
		SendErrorResponse(w, http.StatusConflict, "This call is not attached to a channel", "recording-needs-space")
	case errors.Is(err, service.ErrVoiceUnconfigured):
		SendErrorResponse(w, http.StatusNotImplemented, "Voice is not configured on this server", "voice-unconfigured")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Call invite failed", err.Error())
	}
}
