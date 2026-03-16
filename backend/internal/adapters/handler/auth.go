package handler

import (
	"net/http"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type AuthHandler interface {
	Login(w http.ResponseWriter, r *http.Request)
	RefreshToken(w http.ResponseWriter, r *http.Request)
	Me(w http.ResponseWriter, r *http.Request)
}

type authHandler struct {
	authService *service.AuthService
}

func NewAuthHandler(authService *service.AuthService) AuthHandler {
	return &authHandler{authService: authService}
}

func (h *authHandler) Login(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.LoginRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}

	result, err := h.authService.Login(req)
	if err != nil {
		SendErrorResponse(w, http.StatusUnauthorized, "Authentication failed", err.Error())
		return
	}

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

	SendResult(w, http.StatusOK, domain.APIResponse[domain.Session]{
		Success: true,
		Data: domain.Session{
			ID:       claims.UserID,
			Username: claims.Username,
		},
	})
}
