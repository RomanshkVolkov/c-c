package handler

import (
	"net/http"
	"strconv"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type TelemetryAdminHandler interface {
	ListDevices(w http.ResponseWriter, r *http.Request)
	Timeline(w http.ResponseWriter, r *http.Request)
}

type telemetryAdminHandler struct {
	svc *service.TelemetryService
}

func NewTelemetryAdminHandler(svc *service.TelemetryService) TelemetryAdminHandler {
	return &telemetryAdminHandler{svc: svc}
}

// ListDevices — GET /api/v1/telemetry/devices?projectId= : aggregate per device
// for the diagnostics screen. Org-scoped; superadmin sees all.
func (h *telemetryAdminHandler) ListDevices(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	devices, err := h.svc.ListDevices(user.OrgIDs(), user.Superadmin, r.URL.Query().Get("projectId"))
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list devices", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.TelemetryDeviceSummary]{Success: true, Data: devices})
}

// Timeline — GET /api/v1/telemetry/timeline?deviceId=&sessionId=&projectId=&limit=
// : decrypted batches for one device, newest first.
func (h *telemetryAdminHandler) Timeline(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	qs := r.URL.Query()
	deviceID := qs.Get("deviceId")
	if deviceID == "" {
		SendErrorResponse(w, http.StatusBadRequest, "deviceId is required", "device-required")
		return
	}
	limit := 0
	if v := qs.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	events, err := h.svc.Timeline(
		user.OrgIDs(), user.Superadmin,
		deviceID, qs.Get("sessionId"), qs.Get("projectId"), limit,
	)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load timeline", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.TelemetryEventView]{Success: true, Data: events})
}
