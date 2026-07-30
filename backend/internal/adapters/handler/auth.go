package handler

import (
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
	Me(w http.ResponseWriter, r *http.Request)
	ChangePassword(w http.ResponseWriter, r *http.Request)
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
)

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{failures: make(map[string][]time.Time)}
}

func (l *loginLimiter) locked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-loginWindow)
	kept := l.failures[key][:0]
	for _, t := range l.failures[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.failures[key] = kept
	return len(kept) >= loginMaxFailures
}

func (l *loginLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[key] = append(l.failures[key], time.Now())
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
	if h.limiter.locked(key) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many attempts", "rate-limited")
		return
	}

	result, err := h.authService.Login(req)
	if err != nil {
		h.limiter.fail(key)
		SendErrorResponse(w, http.StatusUnauthorized, "Authentication failed", err.Error())
		return
	}
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
		SendErrorResponse(w, http.StatusUnauthorized, "Invalid refresh token", err.Error())
		return
	}

	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AuthRefreshResponse]{
		Success: true,
		Data:    result,
	})
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
	if err := h.authService.ChangePassword(claims.UserID, req.CurrentPassword, req.NewPassword); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Could not change password", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Password changed"})
}
