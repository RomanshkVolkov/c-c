package domain

import (
	"encoding/json"
	"strings"
	"time"
)

// TelemetryEvent is one flushed batch of passive debug telemetry from a native
// app (device context + breadcrumbs). Stored separately from Report: high
// volume, queried by device/session for diagnostics (never the triage inbox),
// encrypted at rest with a short TTL. OrgID is denormalized from the project so
// scoping/purge queries don't need a join.
type TelemetryEvent struct {
	BaseModel
	ProjectID  string `gorm:"type:varchar(36);index;not null" json:"projectId"`
	OrgID      string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	DeviceID   string `gorm:"type:varchar(255);index"         json:"deviceId"`
	SessionID  string `gorm:"type:varchar(255);index"         json:"sessionId"`
	Platform   string `gorm:"type:varchar(20)"                json:"platform"`
	AppVersion string `gorm:"type:varchar(50)"                json:"appVersion"`
	// Plaintext summary columns for filtering without decrypting.
	ReqCount   int `gorm:"default:0" json:"reqCount"`
	ErrorCount int `gorm:"default:0" json:"errorCount"`
	WarnCount  int `gorm:"default:0" json:"warnCount"`
	// Heartbeat: el lote trae un latido. En claro para pintar la tira de
	// latidos sin descifrar cada lote.
	Heartbeat bool `gorm:"default:false" json:"heartbeat"`
	// Payload is the AES-GCM blob (device context + breadcrumbs, re-redacted).
	Payload    []byte    `gorm:"type:bytea" json:"-"`
	ReceivedAt time.Time `gorm:"index"      json:"receivedAt"`
	ExpiresAt  time.Time `gorm:"index"      json:"expiresAt"`
}

// ─── Ingest (public, native apps) ─────────────────────────────────────────────

// IngestEventBatch is the body of POST /ingest/v1/events. `device` and the full
// breadcrumb objects are stored encrypted; the typed fields feed the plaintext
// summary/index columns.
type IngestEventBatch struct {
	DeviceID    string            `json:"deviceId"   validate:"required"`
	SessionID   string            `json:"sessionId"`
	Platform    string            `json:"platform"`
	AppVersion  string            `json:"appVersion"`
	Device      json.RawMessage   `json:"device"`
	Breadcrumbs []json.RawMessage `json:"breadcrumbs"`
}

// crumbSummary peeks at a breadcrumb just enough to tally it, without
// committing to the full RN breadcrumb schema.
type crumbSummary struct {
	Type string `json:"type"`
}

// BatchSummary es lo que se cuenta de un lote sin descifrarlo después.
type BatchSummary struct {
	Requests int
	Errors   int
	Warnings int
	// Heartbeat: el lote trae al menos un latido. Lo usa el vigilante.
	Heartbeat bool
}

// Summarize cuenta peticiones, errores y avisos. La gravedad es la de
// CrumbSeverity, la misma que ven la pantalla y el MCP.
func (b IngestEventBatch) Summarize() BatchSummary {
	var out BatchSummary
	for _, raw := range b.Breadcrumbs {
		var c crumbSummary
		if err := json.Unmarshal(raw, &c); err != nil {
			continue
		}
		if isNetworkType(c.Type) {
			out.Requests++
		}
		if c.Type == "heartbeat" {
			out.Heartbeat = true
		}
		switch CrumbSeverity(raw) {
		case SeverityError:
			out.Errors++
		case SeverityWarn:
			out.Warnings++
		}
	}
	return out
}

// ─── Estado por dispositivo ───────────────────────────────────────────────────

// TelemetryDevice es una fila por (proyecto, dispositivo), puesta al día en
// cada lote. Existe por tres cosas que la tabla de lotes no podía dar:
//
//   - cómo se llama el dispositivo y de quién es (`label`, `subject`), en claro
//     para poder buscar — salen del JSON ya redactado, así que un correo nunca
//     llega aquí;
//   - la versión **del último lote**: agregando lotes sólo había `MAX()`, que
//     compara texto y dice que «1.9» es más nueva que «1.10»;
//   - dónde guarda el vigilante si ya avisó, para avisar una vez y no cada
//     cinco minutos.
type TelemetryDevice struct {
	BaseModel
	ProjectID  string     `gorm:"type:varchar(36);not null;uniqueIndex:idx_telemetry_device,priority:1" json:"projectId"`
	DeviceID   string     `gorm:"type:varchar(255);not null;uniqueIndex:idx_telemetry_device,priority:2" json:"deviceId"`
	OrgID      string     `gorm:"type:varchar(36);index;not null" json:"orgId"`
	Label      string     `gorm:"type:varchar(120)"               json:"label"`
	Subject    string     `gorm:"type:varchar(120);index"         json:"subject"`
	Platform   string     `gorm:"type:varchar(20)"                json:"platform"`
	AppVersion string     `gorm:"type:varchar(50)"                json:"appVersion"`
	SessionID  string     `gorm:"type:varchar(255)"               json:"sessionId"`
	FirstSeen  time.Time  `json:"firstSeen"`
	LastSeen   time.Time  `gorm:"index" json:"lastSeen"`
	LastBeatAt *time.Time `json:"lastHeartbeatAt,omitempty"`
	// Snapshot: el `device` del último lote, redactado y cifrado como el lote.
	Snapshot []byte `gorm:"type:bytea" json:"-"`
	// Incidentes abiertos por el vigilante. nil = cerrado.
	SilentSince    *time.Time `json:"silentSince,omitempty"`
	UnhealthySince *time.Time `json:"unhealthySince,omitempty"`
}

// ─── Admin (console diagnostics) ──────────────────────────────────────────────

// TelemetryDeviceSummary is one row of the diagnostics device list.
type TelemetryDeviceSummary struct {
	DeviceID        string        `json:"deviceId"    gorm:"column:device_id"`
	ProjectID       string        `json:"projectId"   gorm:"column:project_id"`
	ProjectName     string        `json:"projectName" gorm:"column:project_name"`
	Label           string        `json:"label"       gorm:"column:label"`
	Subject         string        `json:"subject"     gorm:"column:subject"`
	Platform        string        `json:"platform"    gorm:"column:platform"`
	AppVersion      string        `json:"appVersion"  gorm:"column:app_version"`
	Batches         int64         `json:"batches"     gorm:"column:batches"`
	ReqCount        int64         `json:"reqCount"    gorm:"column:req_count"`
	ErrorCount      int64         `json:"errorCount"  gorm:"column:error_count"`
	WarnCount       int64         `json:"warnCount"   gorm:"column:warn_count"`
	LastSeen        time.Time     `json:"lastSeen"    gorm:"column:last_seen"`
	LastHeartbeatAt *time.Time    `json:"lastHeartbeatAt,omitempty" gorm:"column:last_beat_at"`
	SilentSince     *time.Time    `json:"silentSince,omitempty"     gorm:"column:silent_since"`
	Alerts          []HealthAlert `json:"alerts"      gorm:"-"`
	// Snapshot sólo viaja del repositorio al servicio, para evaluar las reglas.
	Snapshot []byte `json:"-" gorm:"column:snapshot"`
}

// TelemetryDevicePage es una página de la lista, con el cursor de la
// siguiente. Antes había un tope de 200 sin aviso: el 201 no existía.
type TelemetryDevicePage struct {
	Devices    []TelemetryDeviceSummary `json:"devices"`
	NextCursor string                   `json:"nextCursor,omitempty"`
}

// TelemetryDeviceDetail es la ficha de un dispositivo: lo que la pantalla pinta
// arriba del timeline y lo que el MCP resume.
type TelemetryDeviceDetail struct {
	TelemetryDeviceSummary
	FirstSeen      time.Time       `json:"firstSeen"`
	SessionID      string          `json:"sessionId"`
	UnhealthySince *time.Time      `json:"unhealthySince,omitempty"`
	Device         json.RawMessage `json:"device"`
	Heartbeat      *Heartbeat      `json:"heartbeat,omitempty"`
	// Heartbeats: cuándo llegó cada latido que sigue guardado, el más viejo
	// primero. Gaps: los huecos más largos que el latido configurado.
	Heartbeats []time.Time    `json:"heartbeats"`
	Gaps       []HeartbeatGap `json:"gaps"`
}

// TelemetryEventView is a decrypted batch for the timeline view.
type TelemetryEventView struct {
	ID          string            `json:"id"`
	ProjectID   string            `json:"projectId"`
	DeviceID    string            `json:"deviceId"`
	SessionID   string            `json:"sessionId"`
	Platform    string            `json:"platform"`
	AppVersion  string            `json:"appVersion"`
	ReqCount    int               `json:"reqCount"`
	ErrorCount  int               `json:"errorCount"`
	WarnCount   int               `json:"warnCount"`
	ReceivedAt  time.Time         `json:"receivedAt"`
	Device      json.RawMessage   `json:"device"`
	Breadcrumbs []json.RawMessage `json:"breadcrumbs"`
	// Severities va en paralelo a Breadcrumbs: la gravedad de cada uno, ya
	// decidida aquí. Paralelo y no dentro del crumb para no reescribir lo que
	// mandó la app.
	Severities []Severity `json:"severities"`
	// Undecryptable: el lote existe pero no se pudo abrir (la llave cambió).
	// Antes salía vacío sin decir por qué.
	Undecryptable bool `json:"undecryptable,omitempty"`
}

// TimelineQuery son los filtros del timeline.
type TimelineQuery struct {
	DeviceID  string
	ProjectID string
	SessionID string
	Since     *time.Time
	Until     *time.Time
	// Before es el cursor: lotes recibidos estrictamente antes.
	Before      *time.Time
	Types       []string
	MinSeverity Severity
	Limit       int
}

// Filter deja en el lote sólo los crumbs que pasan los filtros de tipo y de
// gravedad, con su gravedad al lado. Devuelve false si no queda ninguno y había
// filtro: un lote vacío no le dice nada a quien filtró.
func (q TimelineQuery) Filter(v *TelemetryEventView) bool {
	types := map[string]bool{}
	for _, t := range q.Types {
		if t = strings.TrimSpace(t); t != "" {
			types[t] = true
		}
	}
	filtering := len(types) > 0 || q.MinSeverity.rank() > 0
	crumbs := make([]json.RawMessage, 0, len(v.Breadcrumbs))
	sevs := make([]Severity, 0, len(v.Breadcrumbs))
	for _, raw := range v.Breadcrumbs {
		sev := CrumbSeverity(raw)
		if len(types) > 0 {
			var c crumbSummary
			_ = json.Unmarshal(raw, &c)
			if !types[c.Type] {
				continue
			}
		}
		if !sev.AtLeast(q.MinSeverity) {
			continue
		}
		crumbs = append(crumbs, raw)
		sevs = append(sevs, sev)
	}
	v.Breadcrumbs, v.Severities = crumbs, sevs
	return !filtering || len(crumbs) > 0
}
