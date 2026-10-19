package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Dar de alta por correo y restablecer la contraseña. Ver domain/account.go.
//
// Las rutas públicas (las del enlace y «olvidé mi contraseña») cuentan
// intentos como el login: por IP, y pedir un enlace también por cuenta. Un
// enlace son 32 bytes al azar, así que adivinarlo no es el riesgo; lo es
// llenar el buzón de alguien de correos, o usar la respuesta para averiguar
// qué cuentas hay.
type AccountHandler struct {
	svc     *service.AccountService
	limiter *loginLimiter
}

const (
	// Pedir enlaces: pocos, porque cada uno es un correo a alguien.
	forgotMaxPerLogin = 3
	forgotMaxPerIP    = 10
	// Usar o mirar un enlace que no vale.
	linkMaxFailuresPerIP = 20
)

func NewAccountHandler(svc *service.AccountService) *AccountHandler {
	return &AccountHandler{svc: svc, limiter: newLoginLimiter()}
}

// Create: `POST /organizations/{id}/accounts`, un admin da de alta a alguien.
func (h *AccountHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, orgID, ok := requireOrgAdmin(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateAccountRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.CreateForOrg(r.Context(), orgID, user.UserID, r.Header.Get("Accept-Language"), req)
	if err != nil {
		accountError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CreateAccountResponse]{Success: true, Data: out})
}

// Resend: `POST /organizations/{id}/accounts/{userId}/resend`, otro enlace de
// bienvenida para quien no terminó el registro.
func (h *AccountHandler) Resend(w http.ResponseWriter, r *http.Request) {
	user, orgID, ok := requireOrgAdmin(w, r)
	if !ok {
		return
	}
	out, err := h.svc.ResendWelcome(r.Context(), orgID, chi.URLParam(r, "userId"), user.UserID, r.Header.Get("Accept-Language"))
	if err != nil {
		accountError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.CreateAccountResponse]{Success: true, Data: out})
}

// Inspect: `POST /public/account/inspect`, de quién es un enlace.
func (h *AccountHandler) Inspect(w http.ResponseWriter, r *http.Request) {
	req, ipKey, ok := linkRequest[domain.AccountLinkRequest](h, w, r)
	if !ok {
		return
	}
	info, err := h.svc.InspectLink(req.Token)
	if err != nil {
		h.linkFailed(w, ipKey, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AccountLinkInfo]{Success: true, Data: info})
}

// Welcome: `POST /public/account/welcome`, elegir usuario y contraseña.
func (h *AccountHandler) Welcome(w http.ResponseWriter, r *http.Request) {
	req, ipKey, ok := linkRequest[domain.CompleteWelcomeRequest](h, w, r)
	if !ok {
		return
	}
	out, err := h.svc.CompleteWelcome(req)
	if err != nil {
		h.linkFailed(w, ipKey, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AuthResponse]{Success: true, Data: out})
}

// Forgot: `POST /public/account/forgot`. Contesta 202 haya o no cuenta.
func (h *AccountHandler) Forgot(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.ForgotPasswordRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	key := "forgot:" + strings.ToLower(strings.TrimSpace(req.Login))
	ipKey := "forgot-ip:" + clientIP(r)
	if h.limiter.locked(key, forgotMaxPerLogin) || h.limiter.locked(ipKey, forgotMaxPerIP) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many attempts", "rate-limited")
		return
	}
	// Cada petición cuenta, salga o no un correo: lo que se frena es pedir.
	h.limiter.fail(key)
	h.limiter.fail(ipKey)
	if err := h.svc.ForgotPassword(r.Context(), req.Login, r.Header.Get("Accept-Language")); err != nil {
		accountError(w, err)
		return
	}
	SendResult(w, http.StatusAccepted, domain.APIResponse[any]{Success: true})
}

// Reset: `POST /public/account/reset`, la contraseña nueva.
func (h *AccountHandler) Reset(w http.ResponseWriter, r *http.Request) {
	req, ipKey, ok := linkRequest[domain.ResetPasswordRequest](h, w, r)
	if !ok {
		return
	}
	out, err := h.svc.ResetPassword(req)
	if err != nil {
		h.linkFailed(w, ipKey, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AuthResponse]{Success: true, Data: out})
}

// linkRequest valida el cuerpo de una ruta con enlace y mira el freno por IP.
func linkRequest[T any](h *AccountHandler, w http.ResponseWriter, r *http.Request) (T, string, bool) {
	ipKey := "link-ip:" + clientIP(r)
	if h.limiter.locked(ipKey, linkMaxFailuresPerIP) {
		var zero T
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many attempts", "rate-limited")
		return zero, ipKey, false
	}
	req, err := ValidateRequest[T](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return req, ipKey, false
	}
	return req, ipKey, true
}

// linkFailed: un enlace que no vale cuenta como intento fallido de esa IP;
// elegir un usuario ocupado, no.
func (h *AccountHandler) linkFailed(w http.ResponseWriter, ipKey string, err error) {
	if errors.Is(err, repository.ErrLinkInvalid) {
		h.limiter.fail(ipKey)
	}
	accountError(w, err)
}

func accountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repository.ErrLinkInvalid):
		SendErrorResponse(w, http.StatusGone, "The link is not valid anymore", "link-invalid")
	case errors.Is(err, repository.ErrUsernameTaken):
		SendErrorResponse(w, http.StatusConflict, "That username is taken", "username-taken")
	case errors.Is(err, service.ErrBadUsername):
		SendErrorResponse(w, http.StatusBadRequest, "That username is not valid", "bad-username")
	case errors.Is(err, repository.ErrEmailTaken):
		SendErrorResponse(w, http.StatusConflict, "That email already has an account", "email-taken")
	case errors.Is(err, repository.ErrAlreadyMember):
		SendErrorResponse(w, http.StatusConflict, "Already a member", "already-member")
	case errors.Is(err, repository.ErrInvitationExists):
		SendErrorResponse(w, http.StatusConflict, "Already invited", "invitation-exists")
	case errors.Is(err, service.ErrAccountNotFound):
		SendErrorResponse(w, http.StatusNotFound, "No pending account", "account-not-pending")
	case errors.Is(err, service.ErrMailOff):
		SendErrorResponse(w, http.StatusServiceUnavailable, "Email is not configured", "email-off")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Account error", "account-failed")
	}
}
