package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Una llamada guardada, para la tarjeta de su resumen. Ver
// domain/call_session.go.
type CallSessionHandler interface {
	Get(w http.ResponseWriter, r *http.Request)
}

type callSessionHandler struct{ svc *service.CallSessionService }

func NewCallSessionHandler(svc *service.CallSessionService) CallSessionHandler {
	return &callSessionHandler{svc: svc}
}

// Get: quién estuvo, cuánto duró y si se grabó. La pertenencia es a la
// organización de **la llamada**, no a la que diga quien pregunta: otra org
// recibe 404, como una grabación.
func (h *callSessionHandler) Get(w http.ResponseWriter, r *http.Request) {
	cs, out, err := h.svc.Get(chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, repository.ErrCallSessionNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the call", err.Error())
		return
	}
	if _, ok := authorizeOrg(w, r, cs.OrgID, false); !ok {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.CallSessionResponse]{Success: true, Data: out})
}
