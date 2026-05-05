package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type CollectionHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Get(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	Delete(w http.ResponseWriter, r *http.Request)
	ReplaceTree(w http.ResponseWriter, r *http.Request)
	ListShares(w http.ResponseWriter, r *http.Request)
	Share(w http.ResponseWriter, r *http.Request)
	Unshare(w http.ResponseWriter, r *http.Request)
}

type collectionHandler struct {
	svc *service.CollectionService
}

func NewCollectionHandler(svc *service.CollectionService) CollectionHandler {
	return &collectionHandler{svc: svc}
}

func currentUser(r *http.Request) (*domain.ClaimsJWT, bool) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	return claims, ok && claims != nil
}

func mapDomainError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrCollectionNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Collection not found", err.Error())
	case errors.Is(err, repository.ErrShareNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Share not found", err.Error())
	case errors.Is(err, repository.ErrCollectionForbidden):
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", err.Error())
	default:
		return false
	}
	return true
}

func (h *collectionHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	items, err := h.svc.ListAccessible(user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list collections", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.CollectionListItem]{Success: true, Data: items})
}

func (h *collectionHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.CreateCollectionRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	item, err := h.svc.Create(user.UserID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create collection", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CollectionListItem]{Success: true, Data: item})
}

func (h *collectionHandler) Get(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	resp, err := h.svc.Get(user.UserID, id)
	if err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load collection", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.CollectionDetailResponse]{Success: true, Data: resp})
}

func (h *collectionHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	req, err := ValidateRequest[domain.UpdateCollectionRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	item, err := h.svc.Update(user.UserID, id, req)
	if err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update collection", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.CollectionListItem]{Success: true, Data: item})
}

func (h *collectionHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.svc.Delete(user.UserID, id); err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete collection", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Collection deleted"})
}

func (h *collectionHandler) ReplaceTree(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	req, err := ValidateRequest[domain.ReplaceTreeRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	nodes, err := h.svc.ReplaceTree(user.UserID, id, req)
	if err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update tree", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.CollectionNode]{Success: true, Data: nodes})
}

func (h *collectionHandler) ListShares(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	shares, err := h.svc.ListShares(user.UserID, id)
	if err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list shares", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ShareInfo]{Success: true, Data: shares})
}

func (h *collectionHandler) Share(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	req, err := ValidateRequest[domain.ShareCollectionRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	share, err := h.svc.Share(user.UserID, id, req)
	if err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusBadRequest, "Failed to share collection", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ShareInfo]{Success: true, Data: share})
}

func (h *collectionHandler) Unshare(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	targetID := chi.URLParam(r, "userId")
	if err := h.svc.Unshare(user.UserID, id, targetID); err != nil {
		if mapDomainError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to revoke share", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Share revoked"})
}

// ─── User search ─────────────────────────────────────────────────────────────

type UserHandler interface {
	Search(w http.ResponseWriter, r *http.Request)
}

type userHandler struct {
	authService *service.AuthService
}

func NewUserHandler(authService *service.AuthService) UserHandler {
	return &userHandler{authService: authService}
}

func (h *userHandler) Search(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		SendResult(w, http.StatusOK, domain.APIResponse[[]domain.UserSummary]{Success: true, Data: []domain.UserSummary{}})
		return
	}
	limit := 10
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 50 {
			limit = n
		}
	}
	results, err := h.authService.SearchUsers(q, user.UserID, limit)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "User search failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.UserSummary]{Success: true, Data: results})
}
