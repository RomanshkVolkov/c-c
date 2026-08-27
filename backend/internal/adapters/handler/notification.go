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
	Prefs(w http.ResponseWriter, r *http.Request)
	SavePrefs(w http.ResponseWriter, r *http.Request)
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

// Prefs and SavePrefs answer only for the caller, like everything else here.
func (h *notificationHandler) Prefs(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	p, err := h.svc.Prefs(user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load preferences", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.NotificationPrefs]{Success: true, Data: p})
}

func (h *notificationHandler) SavePrefs(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	var req domain.NotificationPrefs
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// The id comes from the token and never from the body: otherwise this would
	// be "set anybody's preferences", which is a different feature with a
	// different answer about who may ask.
	req.UserID = user.UserID
	// Mentions are not negotiable — see the domain. Forced rather than ignored,
	// so a client that sends false gets the truth back in the response instead
	// of a value the server will never honour.
	req.Mentions = true
	if err := h.svc.SavePrefs(req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save preferences", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.NotificationPrefs]{Success: true, Data: req})
}

func (h *notificationHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	var req struct {
		IDs []string `json:"ids"`
		// Group marca de una vez todo lo no leído de una conversación.
		//
		// Hace falta porque el cliente sólo tiene los ids de la página: con un
		// grupo de cuarenta y siete y una página de doce, marcar por ids dejaría
		// la fila diciendo cero y el badge en treinta y cinco.
		Group string `json:"group"`
		OrgID string `json:"orgId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// Scoped to the caller inside the query, not checked here: ids alone would
	// otherwise let anybody mark somebody else's inbox read. Lo mismo vale para
	// la clave de grupo: sin acotarla, sería la bandeja de cualquiera.
	if req.Group != "" {
		if err := h.svc.MarkReadGroup(user.UserID, req.OrgID, req.Group); err != nil {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to mark read", err.Error())
			return
		}
	}
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
