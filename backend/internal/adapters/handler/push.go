package handler

import (
	"net/http"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// PushHandler: suscribir este dispositivo a la campana (W2). Todo es de quien
// tiene el token: no hay forma de suscribir, ver o dar de baja el dispositivo
// de otra persona.
type PushHandler struct{ svc *service.PushService }

func NewPushHandler(svc *service.PushService) *PushHandler { return &PushHandler{svc: svc} }

// Key: la llave pública VAPID. Vacía si el servidor no tiene push, y la web no
// ofrece el botón en vez de enseñar uno que no hace nada.
func (h *PushHandler) Key(w http.ResponseWriter, r *http.Request) {
	SendResult(w, http.StatusOK, domain.APIResponse[domain.PushKeyResponse]{
		Success: true, Data: domain.PushKeyResponse{Key: h.svc.PublicKey()},
	})
}

func (h *PushHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if !h.svc.Configured() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Push is not configured", "push-off")
		return
	}
	req, err := ValidateRequest[domain.PushSubscribeRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.Subscribe(user.UserID, r.UserAgent(), req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Subscribe failed", "push-subscribe-failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *PushHandler) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	// Por la query y no por el cuerpo: un DELETE con cuerpo es raro, y el
	// cliente de la app no lo manda.
	endpoint := r.URL.Query().Get("endpoint")
	if endpoint == "" || len(endpoint) > 2000 {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "missing-endpoint")
		return
	}
	if err := h.svc.Unsubscribe(user.UserID, endpoint); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Unsubscribe failed", "push-unsubscribe-failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
