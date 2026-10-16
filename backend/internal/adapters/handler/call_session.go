package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Una llamada guardada: la tarjeta de su resumen y su chat. Ver
// domain/call_session.go y domain/call_message.go.
type CallSessionHandler interface {
	Get(w http.ResponseWriter, r *http.Request)
	ListMessages(w http.ResponseWriter, r *http.Request)
	PostMessage(w http.ResponseWriter, r *http.Request)
	EditMessage(w http.ResponseWriter, r *http.Request)
	WithdrawMessage(w http.ResponseWriter, r *http.Request)
}

type callSessionHandler struct{ svc *service.CallSessionService }

func NewCallSessionHandler(svc *service.CallSessionService) CallSessionHandler {
	return &callSessionHandler{svc: svc}
}

// session resuelve la llamada y comprueba la pertenencia **a la organización
// de la llamada**, no a la que diga quien pregunta: otra org recibe 404.
func (h *callSessionHandler) session(w http.ResponseWriter, r *http.Request, needWrite bool) (*domain.CallSession, *domain.ClaimsJWT, bool) {
	cs, err := h.svc.Find(chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, repository.ErrCallSessionNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return nil, nil, false
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the call", err.Error())
		return nil, nil, false
	}
	user, ok := authorizeOrg(w, r, cs.OrgID, needWrite)
	if !ok {
		return nil, nil, false
	}
	return cs, user, true
}

// Get: quién estuvo, cuánto duró, cuántos mensajes y si se grabó.
func (h *callSessionHandler) Get(w http.ResponseWriter, r *http.Request) {
	cs, _, ok := h.session(w, r, false)
	if !ok {
		return
	}
	_, out, err := h.svc.Get(cs.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the call", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.CallSessionResponse]{Success: true, Data: out})
}

func (h *callSessionHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	cs, _, ok := h.session(w, r, false)
	if !ok {
		return
	}
	out, err := h.svc.Messages(cs.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the chat", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.CallMessage]{Success: true, Data: out})
}

func (h *callSessionHandler) PostMessage(w http.ResponseWriter, r *http.Request) {
	cs, user, ok := h.session(w, r, true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CallMessageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	m, err := h.svc.PostMessage(cs, user.UserID, user.Username, req.Body)
	if callChatError(w, err) {
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CallMessage]{Success: true, Data: m})
}

func (h *callSessionHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	cs, user, ok := h.session(w, r, true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CallMessageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if callChatError(w, h.svc.EditMessage(cs, chi.URLParam(r, "mid"), user.UserID, req.Body)) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func (h *callSessionHandler) WithdrawMessage(w http.ResponseWriter, r *http.Request) {
	cs, user, ok := h.session(w, r, true)
	if !ok {
		return
	}
	if callChatError(w, h.svc.WithdrawMessage(cs, chi.URLParam(r, "mid"), user.UserID)) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func callChatError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, service.ErrCallEnded):
		SendErrorResponse(w, http.StatusConflict, "This call has ended; its chat is read-only", "call-ended")
	case errors.Is(err, service.ErrNotYourCallMessage):
		SendErrorResponse(w, http.StatusForbidden, "Only the person who wrote this can change it.", "not-the-author")
	case errors.Is(err, repository.ErrCallMessageNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed", err.Error())
	}
	return true
}
