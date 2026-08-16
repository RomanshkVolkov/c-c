package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Direct messages.
//
// Authorization lives in the service, which refuses a conversation you are not
// part of with not-found rather than forbidden — "that thread exists but isn't
// yours" is itself a fact about who talks to whom.
//
// As with the space channels, **nothing here is on the personal-access-token
// allowlist**, and that is deliberate rather than forgotten: this is two people
// talking, and an automated token reading it is not a capability anybody asked
// for.

// OpenDM starts — or finds — the conversation with somebody.
//
// There is no "create": naming the person is the whole operation, and both
// directions land on the same row.
func (h *taskHandler) OpenDM(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	req, err := ValidateRequest[domain.OpenDMRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// The organization is asked for explicitly rather than guessed from the
	// pair: two people can share more than one, and picking for them would put
	// the conversation in a context they didn't choose.
	if _, member := user.RoleInOrg(req.OrgID); !member && !user.Superadmin {
		SendErrorResponse(w, http.StatusForbidden, "You don't belong to that organization", "not-a-member")
		return
	}
	c, err := h.dms.OpenWith(req.OrgID, user.UserID, req.UserID)
	if mapDMError(w, err) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.DMConversation]{Success: true, Data: c})
}

// ListDMConversations answers every thread the caller has, with unread counts.
func (h *taskHandler) ListDMConversations(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	out, err := h.dms.Conversations(user.UserID, user.OrgIDs())
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list conversations", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DMSummary]{Success: true, Data: out})
}

func (h *taskHandler) ListDMMessages(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	var before time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			before = t
		}
	}
	msgs, err := h.dms.List(chi.URLParam(r, "id"), user.UserID, before,
		atoiDefault(r.URL.Query().Get("limit"), 50))
	if mapDMError(w, err) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DMMessageResponse]{Success: true, Data: msgs})
}

func (h *taskHandler) PostDM(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	req, err := ValidateRequest[domain.DMMessageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	id := chi.URLParam(r, "id")
	m, err := h.dms.Post(id, user.UserID, req.Body)
	if mapDMError(w, err) {
		return
	}
	// Writing is reading: nobody wants their own line counted as unread.
	if err := h.dms.MarkRead(id, user.UserID); err != nil {
		lg.Warn("dm: could not move the read mark: " + err.Error())
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.DMMessage]{Success: true, Data: m})
}

func (h *taskHandler) EditDM(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	req, err := ValidateRequest[domain.DMMessageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	err = h.dms.Edit(chi.URLParam(r, "id"), chi.URLParam(r, "messageId"),
		user.UserID, user.Superadmin, req.Body)
	if mapDMError(w, err) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Message updated"})
}

func (h *taskHandler) WithdrawDM(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	err := h.dms.Withdraw(chi.URLParam(r, "id"), chi.URLParam(r, "messageId"),
		user.UserID, user.Superadmin)
	if mapDMError(w, err) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Message withdrawn"})
}

func (h *taskHandler) MarkDMRead(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	if err := h.dms.MarkRead(chi.URLParam(r, "id"), user.UserID); err != nil {
		if mapDMError(w, err) {
			return
		}
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Marked read"})
}

func mapDMError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, repository.ErrNotColleagues):
		SendErrorResponse(w, http.StatusForbidden,
			"You don't share an organization with that person", "not-colleagues")
	case errors.Is(err, service.ErrNotTheAuthor):
		SendErrorResponse(w, http.StatusForbidden,
			"Only the person who wrote this can change it.", "not-the-author")
	case errors.Is(err, repository.ErrConversationNotFound),
		errors.Is(err, repository.ErrDMMessageNotFound):
		// Not-found for a thread that is somebody else's, on purpose: see the
		// service. The two cases are folded together so the answer doesn't
		// distinguish "no such conversation" from "not yours".
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed", err.Error())
	}
	return true
}
