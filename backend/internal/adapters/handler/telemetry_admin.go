package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type TelemetryAdminHandler interface {
	ListDevices(w http.ResponseWriter, r *http.Request)
	Device(w http.ResponseWriter, r *http.Request)
	Timeline(w http.ResponseWriter, r *http.Request)
}

type telemetryAdminHandler struct {
	svc *service.TelemetryService
}

func NewTelemetryAdminHandler(svc *service.TelemetryService) TelemetryAdminHandler {
	return &telemetryAdminHandler{svc: svc}
}

// deviceRow es una fila de la lista con el cursor que lleva a la siguiente
// página **a partir de ella**. Va en la fila y no en un sobre alrededor de la
// lista para que `data` siga siendo un array: una app que no se ha actualizado
// lee la respuesta como siempre.
type deviceRow struct {
	domain.TelemetryDeviceSummary
	Cursor string `json:"cursor,omitempty"`
}

// ListDevices — GET /api/v1/telemetry/devices?projectId=&q=&cursor=&limit= :
// one row per (project, device), most recently seen first. Org-scoped;
// superadmin sees all. When there's a next page, the LAST row carries the
// `cursor` to ask for it.
func (h *telemetryAdminHandler) ListDevices(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	qs := r.URL.Query()
	limit, _ := strconv.Atoi(qs.Get("limit"))
	page, err := h.svc.ListDevices(repository.DeviceQuery{
		OrgIDs: user.OrgIDs(), Superadmin: user.Superadmin,
		ProjectID: qs.Get("projectId"), Q: qs.Get("q"), Cursor: qs.Get("cursor"), Limit: limit,
	})
	if errors.Is(err, repository.ErrBadCursor) {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid cursor", "bad-cursor")
		return
	}
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list devices", err.Error())
		return
	}
	rows := make([]deviceRow, len(page.Devices))
	for i, d := range page.Devices {
		rows[i] = deviceRow{TelemetryDeviceSummary: d}
	}
	if n := len(rows); n > 0 && page.NextCursor != "" {
		rows[n-1].Cursor = page.NextCursor
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]deviceRow]{Success: true, Data: rows})
}

// Device — GET /api/v1/telemetry/devices/{projectId}/{deviceId} : la ficha.
func (h *telemetryAdminHandler) Device(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	d, err := h.svc.Device(user.OrgIDs(), user.Superadmin,
		chi.URLParam(r, "projectId"), chi.URLParam(r, "deviceId"), time.Now())
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load device", err.Error())
		return
	}
	if d == nil {
		SendErrorResponse(w, http.StatusNotFound, "Device not found", "device-not-found")
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.TelemetryDeviceDetail]{Success: true, Data: d})
}

// parseTime acepta RFC 3339 o milisegundos desde la época (lo que manda un
// `Date.now()`).
func parseTime(v string) (*time.Time, error) {
	if v == "" {
		return nil, nil
	}
	if ms, err := strconv.ParseInt(v, 10, 64); err == nil {
		t := time.UnixMilli(ms)
		return &t, nil
	}
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Timeline — GET /api/v1/telemetry/timeline?deviceId=&projectId=&sessionId=
// &since=&until=&before=&types=a,b&minSeverity=warn&limit= : decrypted batches
// for one device, newest first, each crumb with its severity. `before` is the
// cursor: the `receivedAt` of the last batch already shown.
func (h *telemetryAdminHandler) Timeline(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	qs := r.URL.Query()
	q := domain.TimelineQuery{
		DeviceID:  qs.Get("deviceId"),
		ProjectID: qs.Get("projectId"),
		SessionID: qs.Get("sessionId"),
	}
	if q.DeviceID == "" {
		SendErrorResponse(w, http.StatusBadRequest, "deviceId is required", "device-required")
		return
	}
	if v := qs.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			q.Limit = n
		}
	}
	for name, dst := range map[string]**time.Time{"since": &q.Since, "until": &q.Until, "before": &q.Before} {
		t, err := parseTime(qs.Get(name))
		if err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid "+name, "bad-time")
			return
		}
		*dst = t
	}
	if v := qs.Get("types"); v != "" {
		q.Types = strings.Split(v, ",")
	}
	if v := qs.Get("minSeverity"); v != "" {
		q.MinSeverity = domain.ParseSeverity(v)
	}
	events, err := h.svc.Timeline(user.OrgIDs(), user.Superadmin, q)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load timeline", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.TelemetryEventView]{Success: true, Data: events})
}
