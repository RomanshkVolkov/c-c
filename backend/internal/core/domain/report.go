package domain

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// ─── JSON column type ─────────────────────────────────────────────────────────

// StringList persists a []string as JSON (used for allowed_origins). Mirrors the
// KeyValueList pattern already used for collection request fields.
type StringList []string

func (s *StringList) Scan(v any) error {
	if v == nil {
		*s = nil
		return nil
	}
	switch b := v.(type) {
	case []byte:
		return json.Unmarshal(b, s)
	case string:
		return json.Unmarshal([]byte(b), s)
	}
	return fmt.Errorf("StringList: unsupported scan type %T", v)
}

func (s StringList) Value() (driver.Value, error) {
	if s == nil {
		return "[]", nil
	}
	return json.Marshal(s)
}

// ─── State machine ────────────────────────────────────────────────────────────

type ReportStatus string

const (
	ReportPending    ReportStatus = "pending"
	ReportInProgress ReportStatus = "in_progress"
	ReportResolved   ReportStatus = "resolved"
	ReportClosed     ReportStatus = "closed"
)

// reportTransitions is the single server-side source of truth (ported from
// portento's BUG_TICKET_VALID_TRANSITIONS). The app consumes it from an endpoint
// rather than duplicating it — avoids portento's client/server drift gotcha.
var reportTransitions = map[ReportStatus][]ReportStatus{
	ReportPending:    {ReportInProgress, ReportClosed},
	ReportInProgress: {ReportPending, ReportResolved, ReportClosed},
	ReportResolved:   {ReportInProgress, ReportClosed},
	ReportClosed:     {},
}

func (s ReportStatus) IsValid() bool {
	_, ok := reportTransitions[s]
	return ok
}

// CanTransitionTo reports whether s → to is a legal transition.
func (s ReportStatus) CanTransitionTo(to ReportStatus) bool {
	for _, allowed := range reportTransitions[s] {
		if allowed == to {
			return true
		}
	}
	return false
}

// ReportTransitions returns a copy-safe view of the state machine for the
// shared endpoint the Tauri app consumes.
func ReportTransitions() map[ReportStatus][]ReportStatus { return reportTransitions }

type ReportCommentKind string

const (
	CommentKindUser   ReportCommentKind = "user"
	CommentKindSystem ReportCommentKind = "system"
)

// ─── Models ───────────────────────────────────────────────────────────────────

// ReportProject is one client website (portento, cliente-2, …) that ingests
// reports. The ingest key is write-only and shown to the admin exactly once.
type ReportProject struct {
	BaseModel
	OrgID            string     `gorm:"type:varchar(36);index;not null"        json:"orgId"`
	Name             string     `gorm:"type:varchar(120);not null"             json:"name"`
	Slug             string     `gorm:"type:varchar(120);uniqueIndex;not null" json:"slug"`
	IngestKeyHash    []byte     `gorm:"type:bytea;not null"                    json:"-"`
	AllowedOrigins   StringList `gorm:"type:jsonb"                             json:"allowedOrigins"`
	RateLimitPerHour int        `gorm:"default:20"                             json:"rateLimitPerHour"`
	IsActive         bool       `gorm:"default:true"                           json:"isActive"`
}

// Report is a single bug report. seq is a short per-project folio (PROJ-123).
type Report struct {
	BaseModel
	ProjectID        string         `gorm:"type:varchar(36);index;not null" json:"projectId"`
	Seq              int            `gorm:"not null"                        json:"seq"`
	Title            string         `gorm:"type:varchar(200);not null"      json:"title"`
	Description      string         `gorm:"type:text"                       json:"description"`
	Status           ReportStatus   `gorm:"type:varchar(20);default:'pending'" json:"status"`
	URL              string         `gorm:"type:text"                       json:"url"`
	UserAgent        string         `gorm:"type:text"                       json:"userAgent"`
	Viewport         string         `gorm:"type:varchar(50)"                json:"viewport"`
	Telemetry        []byte         `gorm:"type:bytea"                      json:"-"` // AES-GCM blob (decision 7)
	TelemetryPurgeAt *time.Time     `json:"telemetryPurgeAt,omitempty"`
	ReporterName     string         `gorm:"type:varchar(120)"               json:"reporterName"`
	ReporterEmail    string         `gorm:"type:varchar(255)"               json:"reporterEmail"`
	AssigneeUserID   *string        `gorm:"type:varchar(36);index"          json:"assigneeUserId,omitempty"`
	ResolvedAt       *time.Time     `json:"resolvedAt,omitempty"`
	DeletedAt        gorm.DeletedAt `gorm:"index"                           json:"-"`
}

type ReportComment struct {
	BaseModel
	ReportID     string            `gorm:"type:varchar(36);index;not null" json:"reportId"`
	Kind         ReportCommentKind `gorm:"type:varchar(10);default:'user'" json:"kind"`
	AuthorUserID *string           `gorm:"type:varchar(36)"                json:"authorUserId,omitempty"`
	Body         string            `gorm:"type:text;not null"              json:"body"`
	DeletedAt    gorm.DeletedAt    `gorm:"index"                           json:"-"`
}

// ReportImage is an uploaded screenshot. CommentID null = report gallery; set =
// inline in a comment. The `path` is the storage key returned by image-service.
type ReportImage struct {
	BaseModel
	ReportID  string         `gorm:"type:varchar(36);index;not null" json:"reportId"`
	CommentID *string        `gorm:"type:varchar(36);index"          json:"commentId,omitempty"`
	Path      string         `gorm:"type:text;not null"              json:"-"` // internal storage key
	FileName  string         `gorm:"type:varchar(255)"               json:"fileName"`
	DeletedAt gorm.DeletedAt `gorm:"index"                           json:"-"`
}

// ─── Requests / Responses (report_projects admin) ─────────────────────────────

type CreateReportProjectRequest struct {
	OrgID            string   `json:"orgId"            validate:"required"`
	Name             string   `json:"name"             validate:"required,min=1,max=120"`
	Slug             string   `json:"slug"             validate:"omitempty,min=1,max=120"`
	AllowedOrigins   []string `json:"allowedOrigins"   validate:"omitempty,dive,url"`
	RateLimitPerHour int      `json:"rateLimitPerHour" validate:"omitempty,min=1,max=10000"`
}

type UpdateReportProjectRequest struct {
	Name             string   `json:"name"             validate:"required,min=1,max=120"`
	AllowedOrigins   []string `json:"allowedOrigins"   validate:"omitempty,dive,url"`
	RateLimitPerHour int      `json:"rateLimitPerHour" validate:"omitempty,min=1,max=10000"`
	IsActive         *bool    `json:"isActive"`
}

type ReportProjectResponse struct {
	ID               string    `json:"id"`
	OrgID            string    `json:"orgId"`
	Name             string    `json:"name"`
	Slug             string    `json:"slug"`
	AllowedOrigins   []string  `json:"allowedOrigins"`
	RateLimitPerHour int       `json:"rateLimitPerHour"`
	IsActive         bool      `json:"isActive"`
	CreatedAt        time.Time `json:"createdAt"`
}

// CreateReportProjectResult carries the plaintext ingest key returned exactly
// once at creation time (never persisted, only its HMAC is stored).
type CreateReportProjectResult struct {
	Project   ReportProjectResponse `json:"project"`
	IngestKey string                `json:"ingestKey"`
}

// ─── Ingest (public) ──────────────────────────────────────────────────────────

// IngestImage is one uploaded screenshot as received in the multipart body.
type IngestImage struct {
	FileName    string
	ContentType string
	Data        []byte
}

// IngestReportInput is the parsed public ingest payload.
type IngestReportInput struct {
	Title         string
	Description   string
	URL           string
	UserAgent     string
	Viewport      string
	ReporterName  string
	ReporterEmail string
	Images        []IngestImage
}

// IngestReportResult is the compact confirmation returned to the widget.
type IngestReportResult struct {
	ID     string `json:"id"`
	Seq    int    `json:"seq"`
	Folio  string `json:"folio"` // <project-slug>-<seq>
	Images int    `json:"images"`
}
