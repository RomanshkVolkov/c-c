package domain

import (
	"encoding/json"
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

// crumbSummary peeks at a breadcrumb just enough to tally req/error counts,
// without committing to the full RN breadcrumb schema.
type crumbSummary struct {
	Type   string `json:"type"`
	Status int    `json:"status"`
}

// Summarize returns (reqCount, errorCount) for the batch. A network crumb counts
// as a request; type "error"/"unhandledrejection" or an HTTP status >= 400 (or 0
// = network failure) counts as an error.
func (b IngestEventBatch) Summarize() (reqCount, errorCount int) {
	for _, raw := range b.Breadcrumbs {
		var c crumbSummary
		if err := json.Unmarshal(raw, &c); err != nil {
			continue
		}
		switch c.Type {
		case "network", "request", "fetch", "xhr":
			reqCount++
			if c.Status == 0 || c.Status >= 400 {
				errorCount++
			}
		case "error", "unhandledrejection", "exception":
			errorCount++
		}
	}
	return reqCount, errorCount
}

// ─── Admin (console diagnostics) ──────────────────────────────────────────────

// TelemetryDeviceSummary is one row of the diagnostics device list: an
// aggregate per device (optionally scoped to a project).
type TelemetryDeviceSummary struct {
	DeviceID    string    `json:"deviceId"    gorm:"column:device_id"`
	ProjectID   string    `json:"projectId"   gorm:"column:project_id"`
	ProjectName string    `json:"projectName" gorm:"column:project_name"`
	Platform    string    `json:"platform"    gorm:"column:platform"`
	AppVersion  string    `json:"appVersion"  gorm:"column:app_version"`
	Batches     int64     `json:"batches"     gorm:"column:batches"`
	ReqCount    int64     `json:"reqCount"    gorm:"column:req_count"`
	ErrorCount  int64     `json:"errorCount"  gorm:"column:error_count"`
	LastSeen    time.Time `json:"lastSeen"    gorm:"column:last_seen"`
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
	ReceivedAt  time.Time         `json:"receivedAt"`
	Device      json.RawMessage   `json:"device"`
	Breadcrumbs []json.RawMessage `json:"breadcrumbs"`
}
