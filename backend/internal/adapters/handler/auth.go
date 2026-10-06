package handler

import (
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type AuthHandler interface {
	Login(w http.ResponseWriter, r *http.Request)
	RefreshToken(w http.ResponseWriter, r *http.Request)
	Logout(w http.ResponseWriter, r *http.Request)
	Me(w http.ResponseWriter, r *http.Request)
	ChangePassword(w http.ResponseWriter, r *http.Request)
	UpdateMe(w http.ResponseWriter, r *http.Request)
	SetLocale(w http.ResponseWriter, r *http.Request)
	URLTicket(w http.ResponseWriter, r *http.Request)
}

// loginLimiter throttles failed logins per username to blunt brute force. A
// sliding window of recent failures; once maxFailures is reached the account is
// soft-locked until the window passes. A successful login clears the counter.
// In-memory (per-pod) — fine at this scale; revisit with a shared store if the
// backend goes multi-replica and abuse appears.
type loginLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

const (
	loginMaxFailures = 8
	loginWindow      = 15 * time.Minute
	// Por IP, además de por usuario (barrido, 6-oct-2026): contando sólo por
	// usuario, probar una contraseña contra muchas cuentas no se frenaba nunca.
	// Más alto que el de una cuenta porque una oficina sale por una sola IP.
	loginMaxFailuresPerIP = 30
	// Pasado este número de claves se barren las que ya no tienen fallos
	// recientes: cada usuario inventado era una entrada que no se iba nunca.
	loginSweepAt = 5000
)

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{failures: make(map[string][]time.Time)}
}

func (l *loginLimiter) locked(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := recent(l.failures[key], time.Now().Add(-loginWindow))
	if len(kept) == 0 {
		delete(l.failures, key)
	} else {
		l.failures[key] = kept
	}
	return len(kept) >= max
}

func (l *loginLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[key] = append(l.failures[key], time.Now())
	if len(l.failures) > loginSweepAt {
		cutoff := time.Now().Add(-loginWindow)
		for k, ts := range l.failures {
			if kept := recent(ts, cutoff); len(kept) == 0 {
				delete(l.failures, k)
			} else {
				l.failures[k] = kept
			}
		}
	}
}

func recent(ts []time.Time, cutoff time.Time) []time.Time {
	kept := ts[:0]
	for _, t := range ts {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	return kept
}

// clientIP: la IP de quien llama. Detrás del Gateway es el **último** valor de
// X-Forwarded-For: ése lo añade nuestro proxy, y lo que viniera antes lo
// escribió el cliente y se puede inventar. Sin la cabecera, la del socket.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, key)
}

type authHandler struct {
	authService *service.AuthService
	limiter     *loginLimiter
}

func NewAuthHandler(authService *service.AuthService) AuthHandler {
	return &authHandler{authService: authService, limiter: newLoginLimiter()}
}

func (h *authHandler) Login(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.LoginRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}

	key := strings.ToLower(strings.TrimSpace(req.Username))
	ipKey := "ip:" + clientIP(r)
	if h.limiter.locked(key, loginMaxFailures) || h.limiter.locked(ipKey, loginMaxFailuresPerIP) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many attempts", "rate-limited")
		return
	}

	result, err := h.authService.Login(req)
	if err != nil {
		h.limiter.fail(key)
		h.limiter.fail(ipKey)
		SendErrorResponse(w, http.StatusUnauthorized, "Authentication failed", err.Error())
		return
	}
	// Sólo la cuenta: si un login bueno limpiara la IP, quien tenga una
	// cuenta propia podría reiniciar su cuenta atrás entre intento e intento.
	h.limiter.reset(key)

	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AuthResponse]{
		Success: true,
		Message: "Login successful",
		Data:    result,
	})
}

func (h *authHandler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		SendErrorResponse(w, http.StatusUnauthorized, "Missing token", "missing-token")
		return
	}

	token := strings.TrimPrefix(authHeader, "Bearer ")
	result, err := h.authService.RefreshToken(token)
	if err != nil {
		// 401 sólo cuando el refresh no vale. La app cierra la sesión ante un
		// 401, y desde que el refresh pasa por la base un fallo de Postgres no
		// puede convertirse en echar a todo el mundo: eso es un 500.
		if isRefreshAuthFailure(err) {
			SendErrorResponse(w, http.StatusUnauthorized, "Invalid refresh token", err.Error())
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Refresh failed", "refresh-failed")
		return
	}

	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AuthRefreshResponse]{
		Success: true,
		Data:    result,
	})
}

// isRefreshAuthFailure: el refresh no vale (firma, caducidad, revocado o de
// alguien que ya no existe), a diferencia de que el servidor no pudo mirarlo.
func isRefreshAuthFailure(err error) bool {
	if errors.Is(err, repository.ErrRefreshRevoked) {
		return true
	}
	switch err.Error() {
	case "expired-token", "user not found":
		return true
	}
	return false
}

// Logout revoca la sesión del refresh que se presenta (su familia entera). Sin
// refresh, o con uno que ya no vale, contesta igual: salir es idempotente.
func (h *authHandler) Logout(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token != "" {
		if err := h.authService.Logout(token); err != nil {
			SendErrorResponse(w, http.StatusInternalServerError, "Logout failed", "logout-failed")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *authHandler) Me(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
		return
	}
	session, err := h.authService.Me(claims.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "user-not-found")
		return
	}
	// Tell the caller what its own credential may do, so it doesn't have to
	// attempt a write to find out.
	session.Scopes = claims.Scopes
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Session]{Success: true, Data: session})
}

// SetLocale: en qué idioma quiere leer cac quien llama.
//
// Sobre sí mismo y nada más: no hay forma de cambiarle el idioma a otro, ni
// siquiera siendo superadmin. Es una preferencia de lectura, no un permiso.
func (h *authHandler) SetLocale(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
		return
	}
	req, err := ValidateRequest[domain.SetLocaleRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.authService.SetLocale(claims.UserID, req.Locale); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Could not save the language", "locale-not-saved")
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Language saved"})
}

// UpdateMe: tus propios datos, y sólo los tuyos.
//
// El id sale del token y **no** de la ruta: con `/users/{id}` habría que
// comprobar que el id es el tuyo, y esa comprobación se puede olvidar. Aquí no
// hay nada que olvidar porque no hay id que mandar.
func (h *authHandler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
		return
	}
	req, err := ValidateRequest[domain.UpdateProfileRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.authService.UpdateProfile(claims.UserID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Could not save your profile", "profile-not-saved")
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Profile updated"})
}

func (h *authHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
		return
	}
	req, err := ValidateRequest[domain.ChangePasswordRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if req.CurrentPassword == req.NewPassword {
		SendErrorResponse(w, http.StatusBadRequest, "New password must differ", "same-password")
		return
	}
	// Las demás sesiones quedan cerradas; ésta recibe tokens nuevos.
	tokens, err := h.authService.ChangePassword(claims.UserID, req.CurrentPassword, req.NewPassword, claims.Web)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Could not change password", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AuthRefreshResponse]{Success: true, Message: "Password changed", Data: tokens})
}
