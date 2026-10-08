package repository

import (
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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

// UpsertDevice pone al día la fila del dispositivo con lo que trae un lote.
//
// Lo del último lote **pisa** (versión, plataforma, sesión, ficha, nombre): es
// el estado actual, no un agregado. Un `label` o `subject` vacío no borra el
// que había, porque una app que no los manda en cada lote no está diciendo que
// el dispositivo dejó de tener nombre. El latido sólo avanza.
func (r *TelemetryRepository) UpsertDevice(d *domain.TelemetryDevice) error {
	set := map[string]any{
		"last_seen":   d.LastSeen,
		"updated_at":  d.LastSeen,
		"snapshot":    d.Snapshot,
		"label":       gorm.Expr("COALESCE(NULLIF(?, ''), telemetry_devices.label)", d.Label),
		"subject":     gorm.Expr("COALESCE(NULLIF(?, ''), telemetry_devices.subject)", d.Subject),
		"platform":    gorm.Expr("COALESCE(NULLIF(?, ''), telemetry_devices.platform)", d.Platform),
		"app_version": gorm.Expr("COALESCE(NULLIF(?, ''), telemetry_devices.app_version)", d.AppVersion),
		"session_id":  gorm.Expr("COALESCE(NULLIF(?, ''), telemetry_devices.session_id)", d.SessionID),
	}
	if d.LastBeatAt != nil {
		set["last_beat_at"] = gorm.Expr("GREATEST(telemetry_devices.last_beat_at, ?)", *d.LastBeatAt)
	}
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "project_id"}, {Name: "device_id"}},
		DoUpdates: clause.Assignments(set),
	}).Create(d).Error
}

// DeviceQuery son los filtros de la lista de dispositivos.
type DeviceQuery struct {
	OrgIDs     []string
	Superadmin bool
	ProjectID  string
	// Q busca en el nombre, en quién lo usa y en el id.
	Q      string
	Cursor string
	Limit  int
}

// El cursor es (last_seen, id) del último de la página: last_seen sola no
// basta, dos dispositivos pueden llegar en el mismo instante.
func encodeDeviceCursor(lastSeen time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(lastSeen.UTC().Format(time.RFC3339Nano) + "|" + id))
}

func decodeDeviceCursor(c string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return time.Time{}, "", err
	}
	at, id, ok := strings.Cut(string(raw), "|")
	if !ok {
		return time.Time{}, "", errors.New("bad cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, at)
	return t, id, err
}

var ErrBadCursor = errors.New("bad cursor")

// ListDevices pagina los dispositivos, los vistos más recientemente primero.
// Los contadores salen de los lotes que siguen guardados (la ventana de
// retención), no de un acumulado eterno.
func (r *TelemetryRepository) ListDevices(q DeviceQuery) (domain.TelemetryDevicePage, error) {
	page := domain.TelemetryDevicePage{Devices: []domain.TelemetryDeviceSummary{}}
	if len(q.OrgIDs) == 0 && !q.Superadmin {
		return page, nil
	}
	if q.Limit <= 0 || q.Limit > 200 {
		q.Limit = 100
	}
	db := r.db.Table("telemetry_devices d").
		Select(`d.id, d.device_id, d.project_id, p.name AS project_name, d.label, d.subject,
			d.platform, d.app_version, d.last_seen, d.last_beat_at, d.silent_since, d.snapshot,
			COALESCE(s.batches,0) AS batches, COALESCE(s.req_count,0) AS req_count,
			COALESCE(s.error_count,0) AS error_count, COALESCE(s.warn_count,0) AS warn_count`).
		Joins("JOIN report_projects p ON p.id = d.project_id").
		Joins(`LEFT JOIN LATERAL (
			SELECT COUNT(*) AS batches, SUM(e.req_count) AS req_count,
				SUM(e.error_count) AS error_count, SUM(e.warn_count) AS warn_count
			FROM telemetry_events e
			WHERE e.project_id = d.project_id AND e.device_id = d.device_id
		) s ON true`).
		Order("d.last_seen DESC, d.id DESC").
		Limit(q.Limit + 1)
	if !q.Superadmin {
		db = db.Where("d.org_id IN ?", q.OrgIDs)
	}
	if q.ProjectID != "" {
		db = db.Where("d.project_id = ?", q.ProjectID)
	}
	if term := strings.TrimSpace(q.Q); term != "" {
		like := "%" + escapeLike(strings.ToLower(term)) + "%"
		db = db.Where(`(LOWER(d.label) LIKE ? ESCAPE '\' OR LOWER(d.subject) LIKE ? ESCAPE '\' OR LOWER(d.device_id) LIKE ? ESCAPE '\')`, like, like, like)
	}
	if q.Cursor != "" {
		at, id, err := decodeDeviceCursor(q.Cursor)
		if err != nil {
			return page, ErrBadCursor
		}
		db = db.Where("(d.last_seen, d.id) < (?, ?)", at, id)
	}
	type row struct {
		domain.TelemetryDeviceSummary
		ID string `gorm:"column:id"`
	}
	var rows []row
	if err := db.Scan(&rows).Error; err != nil {
		return page, err
	}
	if len(rows) > q.Limit {
		last := rows[q.Limit-1]
		page.NextCursor = encodeDeviceCursor(last.LastSeen, last.ID)
		rows = rows[:q.Limit]
	}
	for _, r := range rows {
		page.Devices = append(page.Devices, r.TelemetryDeviceSummary)
	}
	return page, nil
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// FindDevice devuelve la fila de un dispositivo de un proyecto, con el ámbito
// de la organización. nil si no existe o no es suyo.
func (r *TelemetryRepository) FindDevice(orgIDs []string, superadmin bool, projectID, deviceID string) (*domain.TelemetryDevice, error) {
	if len(orgIDs) == 0 && !superadmin {
		return nil, nil
	}
	q := r.db.Where("project_id = ? AND device_id = ?", projectID, deviceID)
	if !superadmin {
		q = q.Where("org_id IN ?", orgIDs)
	}
	var d domain.TelemetryDevice
	err := q.First(&d).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &d, err
}

// DevicesOfProject: todos los dispositivos de un proyecto vistos desde
// `since`. Para el vigilante.
func (r *TelemetryRepository) DevicesOfProject(projectID string, since time.Time) ([]domain.TelemetryDevice, error) {
	var out []domain.TelemetryDevice
	err := r.db.Where("project_id = ? AND last_seen >= ?", projectID, since).Find(&out).Error
	return out, err
}

// SwapIncidents cambia el estado de los incidentes **sólo si sigue siendo el
// que se leyó**, y dice si lo cambió. Es un compare-and-swap a propósito: con
// varias réplicas, cada una corre su vigilante, y con «leer y luego escribir»
// las dos verían el incidente cerrado, lo abrirían y avisarían dos veces. Sólo
// avisa quien gana el cambio.
func (r *TelemetryRepository) SwapIncidents(id string, oldSilent, oldUnhealthy, silentSince, unhealthySince *time.Time) (bool, error) {
	res := r.db.Model(&domain.TelemetryDevice{}).
		Where("id = ? AND silent_since IS NOT DISTINCT FROM ? AND unhealthy_since IS NOT DISTINCT FROM ?", id, oldSilent, oldUnhealthy).
		Updates(map[string]any{"silent_since": silentSince, "unhealthy_since": unhealthySince})
	return res.RowsAffected == 1, res.Error
}

// ListEvents returns raw batches (with encrypted payload) for a timeline, newest
// first. Org-scoped unless superadmin; deviceID is required by the caller.
func (r *TelemetryRepository) ListEvents(orgIDs []string, superadmin bool, q domain.TimelineQuery) ([]domain.TelemetryEvent, error) {
	if len(orgIDs) == 0 && !superadmin {
		return []domain.TelemetryEvent{}, nil
	}
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	db := r.db.Model(&domain.TelemetryEvent{}).
		Where("device_id = ?", q.DeviceID).
		Order("received_at DESC").
		Limit(limit)
	if !superadmin {
		db = db.Where("org_id IN ?", orgIDs)
	}
	if q.SessionID != "" {
		db = db.Where("session_id = ?", q.SessionID)
	}
	if q.ProjectID != "" {
		db = db.Where("project_id = ?", q.ProjectID)
	}
	if q.Since != nil {
		db = db.Where("received_at >= ?", *q.Since)
	}
	if q.Until != nil {
		db = db.Where("received_at <= ?", *q.Until)
	}
	if q.Before != nil {
		db = db.Where("received_at < ?", *q.Before)
	}
	var out []domain.TelemetryEvent
	err := db.Find(&out).Error
	return out, err
}

// HeartbeatTimes: cuándo llegó cada lote con latido desde `since`. Para la
// tira de latidos de la ficha; sólo fechas, sin descifrar nada.
func (r *TelemetryRepository) HeartbeatTimes(projectID, deviceID string, since time.Time) ([]time.Time, error) {
	var out []time.Time
	err := r.db.Model(&domain.TelemetryEvent{}).
		Where("project_id = ? AND device_id = ? AND heartbeat AND received_at >= ?", projectID, deviceID, since).
		Order("received_at ASC").
		Pluck("received_at", &out).Error
	return out, err
}

// PurgeExpired deletes events past their TTL, and the devices nobody has
// heard from in longer than `deviceTTL` — the ones whose batches are all gone.
// Returns the number of events removed.
func (r *TelemetryRepository) PurgeExpired(now time.Time, deviceTTL func(projectID string) time.Duration) (int64, error) {
	res := r.db.Where("expires_at < ?", now).Delete(&domain.TelemetryEvent{})
	if res.Error != nil {
		return 0, res.Error
	}
	// Un dispositivo sin lotes no tiene nada que enseñar. Por proyecto, porque
	// cada uno tiene su ventana.
	var projects []string
	if err := r.db.Model(&domain.TelemetryDevice{}).Distinct().Pluck("project_id", &projects).Error; err != nil {
		return res.RowsAffected, err
	}
	for _, p := range projects {
		if err := r.db.Unscoped().Where("project_id = ? AND last_seen < ?", p, now.Add(-deviceTTL(p))).
			Delete(&domain.TelemetryDevice{}).Error; err != nil {
			return res.RowsAffected, err
		}
	}
	return res.RowsAffected, nil
}

// MissingDevices: (proyecto, dispositivo) con lotes y sin fila en
// telemetry_devices. Los lotes de antes de que existiera la tabla.
func (r *TelemetryRepository) MissingDevices() ([]domain.TelemetryEvent, error) {
	var out []domain.TelemetryEvent
	err := r.db.Raw(`
		SELECT DISTINCT ON (e.project_id, e.device_id) e.*
		FROM telemetry_events e
		WHERE NOT EXISTS (
			SELECT 1 FROM telemetry_devices d
			WHERE d.project_id = e.project_id AND d.device_id = e.device_id
		)
		ORDER BY e.project_id, e.device_id, e.received_at DESC`).Scan(&out).Error
	return out, err
}

// FirstSeen: el lote más viejo que sigue guardado de un dispositivo.
func (r *TelemetryRepository) FirstSeen(projectID, deviceID string) (time.Time, error) {
	var t time.Time
	err := r.db.Model(&domain.TelemetryEvent{}).
		Where("project_id = ? AND device_id = ?", projectID, deviceID).
		Select("MIN(received_at)").Scan(&t).Error
	return t, err
}

// SetFirstSeen corrige cuándo se vio por primera vez (el relleno lo crea con
// la fecha de su último lote).
func (r *TelemetryRepository) SetFirstSeen(projectID, deviceID string, at time.Time) error {
	return r.db.Model(&domain.TelemetryDevice{}).
		Where("project_id = ? AND device_id = ?", projectID, deviceID).
		Update("first_seen", at).Error
}
