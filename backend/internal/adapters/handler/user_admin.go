package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// requireSuperadmin gates the platform user-management endpoints. Returns the
// caller's claims and true only for a superadmin; otherwise writes 401/403.
func requireSuperadmin(w http.ResponseWriter, r *http.Request) (*domain.ClaimsJWT, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, false
	}
	if !user.Superadmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "superadmin-required")
		return nil, false
	}
	return user, true
}

func (h *userHandler) List(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireSuperadmin(w, r); !ok {
		return
	}
	users, err := h.authService.ListUsers()
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list users", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.UserResponse]{Success: true, Data: users})
}

func (h *userHandler) Create(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireSuperadmin(w, r); !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateUserRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, err := h.authService.CreateUser(req)
	if err != nil {
		if errors.Is(err, repository.ErrUsernameTaken) {
			SendErrorResponse(w, http.StatusConflict, "Username already in use", err.Error())
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create user", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.UserResponse]{Success: true, Data: user})
}

func (h *userHandler) Update(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireSuperadmin(w, r); !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateUserRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.authService.UpdateUser(chi.URLParam(r, "id"), req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update user", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "User updated"})
}

func (h *userHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user, ok := requireSuperadmin(w, r)
	if !ok {
		return
	}
	targetID := chi.URLParam(r, "id")
	if targetID == user.UserID {
		SendErrorResponse(w, http.StatusConflict, "Cannot delete yourself", "self-delete")
		return
	}
	if err := h.authService.DeleteUser(targetID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete user", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "User deleted"})
}
