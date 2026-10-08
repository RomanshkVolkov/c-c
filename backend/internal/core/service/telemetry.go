package service

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// TelemetryProjects es lo poco que el servicio necesita de los proyectos: su
// configuración de telemetría.
type TelemetryProjects interface {
	FindByID(id string) (*domain.ReportProject, error)
}

type TelemetryService struct {
	repo     *repository.TelemetryRepository
	projects TelemetryProjects
}

func NewTelemetryService(repo *repository.TelemetryRepository, projects TelemetryProjects) *TelemetryService {
	return &TelemetryService{repo: repo, projects: projects}
}

// defaultTTL returns the retention window for passive telemetry when a project
// doesn't set its own (short by design).
func defaultTTL() time.Duration {
	days := 14
	if v := repository.GetEnv("TELEMETRY_TTL_DAYS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}
	return time.Duration(days) * 24 * time.Hour
}

// Ingest re-redacts and encrypts a batch, computes summary counts, persists it
// against the project's org with the project's TTL, and brings the device's row
// up to date. `now` is injected so callers control the clock (and tests are
// deterministic).
func (s *TelemetryService) Ingest(project *domain.ReportProject, batch domain.IngestEventBatch, now time.Time) error {
	// Se redacta **antes** de sacar nada: el nombre y el sujeto salen del JSON
	// ya limpio, así que un correo nunca llega a una columna en claro.
	device := json.RawMessage(nil)
	if len(batch.Device) > 0 {
		device = json.RawMessage(repository.RedactSensitive(string(batch.Device)))
		if !json.Valid(device) {
			device = nil
		}
	}
	// Canonical payload = device context + breadcrumbs, re-redacted then encrypted.
	blob, err := json.Marshal(map[string]any{
		"device":      batch.Device,
		"breadcrumbs": batch.Breadcrumbs,
	})
	if err != nil {
		return err
	}
	redacted := repository.RedactSensitive(string(blob))
	enc, err := repository.EncryptTelemetry([]byte(redacted))
	if err != nil {
		return err
	}
	sum := batch.Summarize()

	ev := &domain.TelemetryEvent{
		ProjectID:  project.ID,
		OrgID:      project.OrgID,
		DeviceID:   batch.DeviceID,
		SessionID:  batch.SessionID,
		Platform:   batch.Platform,
		AppVersion: batch.AppVersion,
		ReqCount:   sum.Requests,
		ErrorCount: sum.Errors,
		WarnCount:  sum.Warnings,
		Heartbeat:  sum.Heartbeat,
		Payload:    enc,
		ReceivedAt: now,
		ExpiresAt:  now.Add(project.TelemetryConfig.Retention(defaultTTL())),
	}
	if err := s.repo.Create(ev); err != nil {
		return err
	}
	return s.touchDevice(project, batch.DeviceID, batch.SessionID, batch.Platform, batch.AppVersion, device, sum.Heartbeat, now)
}

func (s *TelemetryService) touchDevice(project *domain.ReportProject, deviceID, sessionID, platform, appVersion string, device json.RawMessage, beat bool, at time.Time) error {
	label, subject := domain.DeviceIdentity(device)
	d := &domain.TelemetryDevice{
		ProjectID: project.ID, DeviceID: deviceID, OrgID: project.OrgID,
		Label: label, Subject: subject,
		Platform: platform, AppVersion: appVersion, SessionID: sessionID,
		FirstSeen: at, LastSeen: at,
	}
	if beat {
		d.LastBeatAt = &at
	}
	// Un lote sin `device` no borra la ficha que había.
	if len(device) > 0 {
		snap, err := repository.EncryptTelemetry(device)
		if err != nil {
			return err
		}
		d.Snapshot = snap
	}
	return s.repo.UpsertDevice(d)
}

// openSnapshot descifra la ficha guardada. nil si no hay o no se puede abrir.
func openSnapshot(blob []byte) json.RawMessage {
	if len(blob) == 0 {
		return nil
	}
	plain, err := repository.DecryptTelemetry(blob)
	if err != nil || !json.Valid(plain) {
		return nil
	}
	return plain
}

// configOf devuelve la configuración de un proyecto, cacheada para una pasada.
func (s *TelemetryService) configOf(cache map[string]domain.TelemetryConfig, projectID string) domain.TelemetryConfig {
	if c, ok := cache[projectID]; ok {
		return c
	}
	var c domain.TelemetryConfig
	if s.projects != nil {
		if p, err := s.projects.FindByID(projectID); err == nil && p != nil {
			c = p.TelemetryConfig
		}
	}
	cache[projectID] = c
	return c
}

func (s *TelemetryService) ListDevices(q repository.DeviceQuery) (domain.TelemetryDevicePage, error) {
	page, err := s.repo.ListDevices(q)
	if err != nil {
		return page, err
	}
	cache := map[string]domain.TelemetryConfig{}
	for i := range page.Devices {
		d := &page.Devices[i]
		d.Alerts = []domain.HealthAlert{}
		if rules := s.configOf(cache, d.ProjectID).HealthRules; len(rules) > 0 {
			d.Alerts = domain.EvaluateHealth(openSnapshot(d.Snapshot), rules)
		}
		d.Snapshot = nil
	}
	return page, nil
}

// Device es la ficha: la última foto del dispositivo, las reglas que se
// cumplen y los latidos con sus huecos. nil si no existe o no es de la org.
func (s *TelemetryService) Device(orgIDs []string, superadmin bool, projectID, deviceID string, now time.Time) (*domain.TelemetryDeviceDetail, error) {
	d, err := s.repo.FindDevice(orgIDs, superadmin, projectID, deviceID)
	if err != nil || d == nil {
		return nil, err
	}
	cfg := s.configOf(map[string]domain.TelemetryConfig{}, projectID)
	device := openSnapshot(d.Snapshot)
	out := &domain.TelemetryDeviceDetail{
		TelemetryDeviceSummary: domain.TelemetryDeviceSummary{
			DeviceID: d.DeviceID, ProjectID: d.ProjectID, Label: d.Label, Subject: d.Subject,
			Platform: d.Platform, AppVersion: d.AppVersion, LastSeen: d.LastSeen,
			LastHeartbeatAt: d.LastBeatAt, SilentSince: d.SilentSince,
			Alerts: domain.EvaluateHealth(device, cfg.HealthRules),
		},
		FirstSeen: d.FirstSeen, SessionID: d.SessionID, UnhealthySince: d.UnhealthySince,
		Device: device, Heartbeat: cfg.Heartbeat,
		Heartbeats: []time.Time{}, Gaps: []domain.HeartbeatGap{},
	}
	if p, err := s.projects.FindByID(projectID); err == nil && p != nil {
		out.ProjectName = p.Name
	}
	beats, err := s.repo.HeartbeatTimes(projectID, deviceID, now.Add(-cfg.Retention(defaultTTL())))
	if err != nil {
		return nil, err
	}
	out.Heartbeats = beats
	if cfg.Heartbeat != nil {
		out.Gaps = domain.HeartbeatGaps(beats, cfg.Heartbeat.Silence(), now)
	}
	return out, nil
}

// Timeline returns the decrypted batches for a device, newest first, with each
// crumb's severity and the crumb filters applied.
func (s *TelemetryService) Timeline(orgIDs []string, superadmin bool, q domain.TimelineQuery) ([]domain.TelemetryEventView, error) {
	events, err := s.repo.ListEvents(orgIDs, superadmin, q)
	if err != nil {
		return nil, err
	}
	out := make([]domain.TelemetryEventView, 0, len(events))
	for i := range events {
		v := s.decrypt(&events[i])
		if q.Filter(&v) {
			out = append(out, v)
		}
	}
	return out, nil
}

func (s *TelemetryService) decrypt(e *domain.TelemetryEvent) domain.TelemetryEventView {
	view := domain.TelemetryEventView{
		ID:          e.ID,
		ProjectID:   e.ProjectID,
		DeviceID:    e.DeviceID,
		SessionID:   e.SessionID,
		Platform:    e.Platform,
		AppVersion:  e.AppVersion,
		ReqCount:    e.ReqCount,
		ErrorCount:  e.ErrorCount,
		WarnCount:   e.WarnCount,
		ReceivedAt:  e.ReceivedAt,
		Breadcrumbs: []json.RawMessage{},
		Severities:  []domain.Severity{},
	}
	plain, err := repository.DecryptTelemetry(e.Payload)
	if err != nil {
		view.Undecryptable = true
		return view
	}
	var body struct {
		Device      json.RawMessage   `json:"device"`
		Breadcrumbs []json.RawMessage `json:"breadcrumbs"`
	}
	if err := json.Unmarshal(plain, &body); err != nil {
		view.Undecryptable = true
		return view
	}
	view.Device = body.Device
	if body.Breadcrumbs != nil {
		view.Breadcrumbs = body.Breadcrumbs
	}
	return view
}

// Purge drops events past their TTL, and devices with nothing left to show.
// Returns how many events were removed.
func (s *TelemetryService) Purge(now time.Time) (int64, error) {
	cache := map[string]domain.TelemetryConfig{}
	return s.repo.PurgeExpired(now, func(projectID string) time.Duration {
		return s.configOf(cache, projectID).Retention(defaultTTL())
	})
}

// BackfillDevices crea la fila de los dispositivos que sólo tienen lotes de
// antes de que existiera la tabla, con la ficha de su último lote. Idempotente:
// sólo toca los que faltan. Sin esto, la lista saldría vacía tras desplegar
// hasta que cada teléfono volviera a mandar.
func (s *TelemetryService) BackfillDevices() (int, error) {
	events, err := s.repo.MissingDevices()
	if err != nil {
		return 0, err
	}
	n := 0
	for i := range events {
		e := &events[i]
		v := s.decrypt(e)
		project := &domain.ReportProject{BaseModel: domain.BaseModel{ID: e.ProjectID}, OrgID: e.OrgID}
		if err := s.touchDevice(project, e.DeviceID, e.SessionID, e.Platform, e.AppVersion, v.Device, false, e.ReceivedAt); err != nil {
			return n, err
		}
		if first, err := s.repo.FirstSeen(e.ProjectID, e.DeviceID); err == nil && !first.IsZero() {
			_ = s.repo.SetFirstSeen(e.ProjectID, e.DeviceID, first)
		}
		n++
	}
	return n, nil
}
