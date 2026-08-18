package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type NotificationHandler interface {
	Feed(w http.ResponseWriter, r *http.Request)
	MarkRead(w http.ResponseWriter, r *http.Request)
	MarkAllRead(w http.ResponseWriter, r *http.Request)
}

type notificationHandler struct{ svc *service.NotificationService }

func NewNotificationHandler(svc *service.NotificationService) NotificationHandler {
	return &notificationHandler{svc: svc}
}

// Feed answers only for the caller. There is no id in the path on purpose:
// an inbox is not something you can ask for on somebody else's behalf.
func (h *notificationHandler) Feed(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	feed, err := h.svc.Feed(user.UserID, r.URL.Query().Get("orgId"), limit)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load notifications", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.NotificationFeed]{Success: true, Data: feed})
}

func (h *notificationHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// Scoped to the caller inside the query, not checked here: ids alone would
	// otherwise let anybody mark somebody else's inbox read.
	if err := h.svc.MarkRead(user.UserID, req.IDs); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to mark read", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Marked read"})
}

func (h *notificationHandler) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if err := h.svc.MarkAllRead(user.UserID, r.URL.Query().Get("orgId")); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to mark read", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Marked read"})
}
