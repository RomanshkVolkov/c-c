package repository

import (
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

type TelemetryRepository struct {
	db *gorm.DB
}

func NewTelemetryRepository(db *gorm.DB) *TelemetryRepository {
	return &TelemetryRepository{db: db}
}

func (r *TelemetryRepository) Create(ev *domain.TelemetryEvent) error {
	return r.db.Create(ev).Error
}

// ListDevices aggregates events per (device, project) for the diagnostics list.
// Org-scoped unless superadmin. projectID is an optional filter.
func (r *TelemetryRepository) ListDevices(orgIDs []string, superadmin bool, projectID string) ([]domain.TelemetryDeviceSummary, error) {
	if len(orgIDs) == 0 && !superadmin {
		return []domain.TelemetryDeviceSummary{}, nil
	}
	q := r.db.Table("telemetry_events e").
		Select(`e.device_id, e.project_id, p.name AS project_name,
			MAX(e.platform) AS platform, MAX(e.app_version) AS app_version,
			COUNT(*) AS batches,
			COALESCE(SUM(e.req_count),0) AS req_count,
			COALESCE(SUM(e.error_count),0) AS error_count,
			MAX(e.received_at) AS last_seen`).
		Joins("JOIN report_projects p ON p.id = e.project_id").
		Group("e.device_id, e.project_id, p.name").
		Order("last_seen DESC").
		Limit(200)
	if !superadmin {
		q = q.Where("e.org_id IN ?", orgIDs)
	}
	if projectID != "" {
		q = q.Where("e.project_id = ?", projectID)
	}
	var out []domain.TelemetryDeviceSummary
	err := q.Scan(&out).Error
	return out, err
}

// ListEvents returns raw batches (with encrypted payload) for a timeline, newest
// first. Org-scoped unless superadmin; deviceID is required by the caller.
func (r *TelemetryRepository) ListEvents(orgIDs []string, superadmin bool, deviceID, sessionID, projectID string, limit int) ([]domain.TelemetryEvent, error) {
	if len(orgIDs) == 0 && !superadmin {
		return []domain.TelemetryEvent{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := r.db.Model(&domain.TelemetryEvent{}).
		Where("device_id = ?", deviceID).
		Order("received_at DESC").
		Limit(limit)
	if !superadmin {
		q = q.Where("org_id IN ?", orgIDs)
	}
	if sessionID != "" {
		q = q.Where("session_id = ?", sessionID)
	}
	if projectID != "" {
		q = q.Where("project_id = ?", projectID)
	}
	var out []domain.TelemetryEvent
	err := q.Find(&out).Error
	return out, err
}

// PurgeExpired deletes events past their TTL. Returns the number removed.
func (r *TelemetryRepository) PurgeExpired(now time.Time) (int64, error) {
	res := r.db.Where("expires_at < ?", now).Delete(&domain.TelemetryEvent{})
	return res.RowsAffected, res.Error
}
