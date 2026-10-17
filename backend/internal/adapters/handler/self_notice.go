package handler

import (
	"errors"
	"net/http"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type SelfNoticeHandler struct{ svc *service.SelfNoticeService }

func NewSelfNoticeHandler(svc *service.SelfNoticeService) *SelfNoticeHandler {
	return &SelfNoticeHandler{svc: svc}
}

// Send: un aviso para quien llama. Sin destinatario en el cuerpo ni en la
// ruta, como el resto de la campana: no hay forma de pedirlo para otro.
func (h *SelfNoticeHandler) Send(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.SelfNoticeRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	orgID, err := h.svc.Send(user, domain.ViaFrom(r.Context()), req)
	switch {
	case err == nil:
		SendResult(w, http.StatusOK, domain.APIResponse[domain.SelfNoticeResult]{
			Success: true, Data: domain.SelfNoticeResult{Sent: true, OrgID: orgID},
		})
	case errors.Is(err, service.ErrNoticeOrgAmbiguous):
		// Con la lista, para que el agente elija sin otra consulta.
		SendResult(w, http.StatusConflict, domain.APIResponse[[]domain.SelfNoticeOrg]{
			Success: false, Message: "You belong to several organizations: send orgId", Error: err.Error(),
			Data: h.svc.Orgs(user.Orgs),
		})
	case errors.Is(err, service.ErrNoticeOrgNotMine):
		SendErrorResponse(w, http.StatusForbidden, "Not a member of that organization", err.Error())
	case errors.Is(err, service.ErrNoticeLink):
		SendErrorResponse(w, http.StatusBadRequest, "The link must be a path inside cac", err.Error())
	case errors.Is(err, service.ErrNoticeTooMany):
		SendErrorResponse(w, http.StatusTooManyRequests, "Too many notices; try again later", err.Error())
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to notify", err.Error())
	}
}
