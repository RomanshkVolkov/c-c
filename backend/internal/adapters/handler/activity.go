package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// ActivityHandler: `GET /api/v1/organizations/{id}/activity`. Para cualquiera
// de la org (viewer): ver qué hizo el CI no es tocar nada.
type ActivityHandler struct{ svc *service.ActivityService }

func NewActivityHandler(svc *service.ActivityService) *ActivityHandler {
	return &ActivityHandler{svc: svc}
}

func (h *ActivityHandler) Feed(w http.ResponseWriter, r *http.Request) {
	orgID, ok := scopeOrg(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	q := r.URL.Query()
	f := domain.ActivityFilter{
		Repo:         q.Get("repo"),
		DeployableID: q.Get("deployableId"),
		BeforeID:     q.Get("beforeId"),
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "bad-limit")
			return
		}
		f.Limit = n
	}
	if v := q.Get("before"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "bad-before")
			return
		}
		f.Before = t
	}
	page, err := h.svc.Feed(orgID, f)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Activity feed failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.ActivityPage]{Success: true, Data: page})
}
