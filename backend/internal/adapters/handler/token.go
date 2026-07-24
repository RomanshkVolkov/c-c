package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type TokenHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Revoke(w http.ResponseWriter, r *http.Request)
}

type tokenHandler struct {
	svc *service.TokenService
}

func NewTokenHandler(svc *service.TokenService) TokenHandler {
	return &tokenHandler{svc: svc}
}

func (h *tokenHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	items, err := h.svc.List(user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list tokens", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.TokenResponse]{Success: true, Data: items})
}

// Create mints a read-only token. Reachable only with a JWT: a PAT can't mint
// another PAT (the middleware blocks non-GET for tokens).
func (h *tokenHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.CreateTokenRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	result, err := h.svc.Mint(user.UserID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create token", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CreateTokenResult]{Success: true, Data: result})
}

func (h *tokenHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if err := h.svc.Revoke(chi.URLParam(r, "id"), user.UserID); err != nil {
		if errors.Is(err, repository.ErrTokenNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Token not found", "not-found")
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to revoke token", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Token revoked"})
}
