package service

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type TelemetryService struct {
	repo *repository.TelemetryRepository
}

func NewTelemetryService(repo *repository.TelemetryRepository) *TelemetryService {
	return &TelemetryService{repo: repo}
}

// ttl returns the retention window for passive telemetry (short by design).
func ttl() time.Duration {
	days := 14
	if v := repository.GetEnv("TELEMETRY_TTL_DAYS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}
	return time.Duration(days) * 24 * time.Hour
}

// Ingest re-redacts and encrypts a batch, computes summary counts, and persists
// it against the project's org with a TTL. `now` is injected so callers control
// the clock (and tests are deterministic).
func (s *TelemetryService) Ingest(project *domain.ReportProject, batch domain.IngestEventBatch, now time.Time) error {
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
	reqCount, errorCount := batch.Summarize()

	ev := &domain.TelemetryEvent{
		ProjectID:  project.ID,
		OrgID:      project.OrgID,
		DeviceID:   batch.DeviceID,
		SessionID:  batch.SessionID,
		Platform:   batch.Platform,
		AppVersion: batch.AppVersion,
		ReqCount:   reqCount,
		ErrorCount: errorCount,
		Payload:    enc,
		ReceivedAt: now,
		ExpiresAt:  now.Add(ttl()),
	}
	return s.repo.Create(ev)
}

func (s *TelemetryService) ListDevices(orgIDs []string, superadmin bool, projectID string) ([]domain.TelemetryDeviceSummary, error) {
	return s.repo.ListDevices(orgIDs, superadmin, projectID)
}

// Timeline returns the decrypted batches for a device, newest first.
func (s *TelemetryService) Timeline(orgIDs []string, superadmin bool, deviceID, sessionID, projectID string, limit int) ([]domain.TelemetryEventView, error) {
	events, err := s.repo.ListEvents(orgIDs, superadmin, deviceID, sessionID, projectID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.TelemetryEventView, 0, len(events))
	for i := range events {
		out = append(out, s.decrypt(&events[i]))
	}
	return out, nil
}

func (s *TelemetryService) decrypt(e *domain.TelemetryEvent) domain.TelemetryEventView {
	view := domain.TelemetryEventView{
		ID:         e.ID,
		ProjectID:  e.ProjectID,
		DeviceID:   e.DeviceID,
		SessionID:  e.SessionID,
		Platform:   e.Platform,
		AppVersion: e.AppVersion,
		ReqCount:   e.ReqCount,
		ErrorCount: e.ErrorCount,
		ReceivedAt: e.ReceivedAt,
	}
	plain, err := repository.DecryptTelemetry(e.Payload)
	if err != nil {
		return view // leave device/breadcrumbs nil on a decrypt failure
	}
	var body struct {
		Device      json.RawMessage   `json:"device"`
		Breadcrumbs []json.RawMessage `json:"breadcrumbs"`
	}
	if err := json.Unmarshal(plain, &body); err == nil {
		view.Device = body.Device
		view.Breadcrumbs = body.Breadcrumbs
	}
	return view
}

// Purge drops events past their TTL. Returns how many were removed.
func (s *TelemetryService) Purge(now time.Time) (int64, error) {
	return s.repo.PurgeExpired(now)
}
