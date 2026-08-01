package domain

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"strings"
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

// The report vocabulary is being unified with portento's
// (open / in_progress / done / closed). The rename can't land in one step: the
// console is an installed desktop binary whose users update by hand, so a
// server that suddenly answered "open" would leave every older build with
// reports that match no kanban column — they'd silently vanish from the board.
//
// So the two names are accepted on input *before* the rename, and the old ones
// stay accepted *after* it. Only this map flips direction when the rename
// lands; every call site below keeps working untouched.
var statusAliases = map[ReportStatus]ReportStatus{
	"open": ReportPending,
	"done": ReportResolved,
}

// Canonical folds an accepted alias onto the stored vocabulary. An unknown
// value is returned unchanged so IsValid still rejects it.
func (s ReportStatus) Canonical() ReportStatus {
	if c, ok := statusAliases[s]; ok {
		return c
	}
	return s
}

func (s ReportStatus) IsValid() bool {
	_, ok := reportTransitions[s.Canonical()]
	return ok
}

// CanTransitionTo reports whether s → to is a legal transition. Both sides are
// folded first, so a client on either vocabulary gets the same answer.
func (s ReportStatus) CanTransitionTo(to ReportStatus) bool {
	for _, allowed := range reportTransitions[s.Canonical()] {
		if allowed == to.Canonical() {
			return true
		}
	}
	return false
}

// ReportTransitions returns a copy-safe view of the state machine for the
// shared endpoint the Tauri app consumes.
func ReportTransitions() map[ReportStatus][]ReportStatus { return reportTransitions }

// ─── Taxonomy ─────────────────────────────────────────────────────────────────

// A report carries three orthogonal labels beyond its status:
//
//   - Category — what kind of problem it is. A closed set, asked of the person
//     filing it, because they're the only one who knows.
//   - Priority — how urgently it should be handled. Also a closed set, but set
//     during triage rather than at capture: asked of a reporter, everything
//     comes back urgent.
//   - Area — which part of the product it belongs to. Free text on purpose:
//     "Sala de Operaciones" means something in one tenant and nothing in
//     another, so a global enum could never fit.
type ReportCategory string

const (
	CategoryBug         ReportCategory = "bug"
	CategoryUI          ReportCategory = "ui"
	CategoryPerformance ReportCategory = "performance"
	CategoryData        ReportCategory = "data"
	CategoryOther       ReportCategory = "other"
)

// ReportCategories is the source of truth, exposed over the API so clients
// don't keep their own copy and drift from it — the same reasoning as
// ReportTransitions.
func ReportCategories() []ReportCategory {
	return []ReportCategory{CategoryBug, CategoryUI, CategoryPerformance, CategoryData, CategoryOther}
}

// NormalizeCategory falls back to "other" rather than rejecting. Ingest is a
// public endpoint fed by third-party widgets; losing a real bug report over an
// unrecognised label would be a bad trade.
func NormalizeCategory(s string) ReportCategory {
	for _, c := range ReportCategories() {
		if string(c) == s {
			return c
		}
	}
	return CategoryOther
}

type ReportPriority string

const (
	ReportPriorityLow    ReportPriority = "low"
	ReportPriorityMedium ReportPriority = "medium"
	ReportPriorityHigh   ReportPriority = "high"
	ReportPriorityUrgent ReportPriority = "urgent"
)

// ReportPriorities is ordered low → urgent; clients render it in this order.
func ReportPriorities() []ReportPriority {
	return []ReportPriority{ReportPriorityLow, ReportPriorityMedium, ReportPriorityHigh, ReportPriorityUrgent}
}

func NormalizePriority(s string) ReportPriority {
	for _, p := range ReportPriorities() {
		if string(p) == s {
			return p
		}
	}
	return ReportPriorityMedium
}

// IsValid is for the admin API, which — unlike ingest — should refuse a value
// it doesn't understand instead of silently filing it as something else.
func (c ReportCategory) IsValid() bool { return NormalizeCategory(string(c)) == c }
func (p ReportPriority) IsValid() bool { return NormalizePriority(string(p)) == p }

// maxAreaLen matches the column width; longer input is cut rather than refused,
// for the same reason NormalizeCategory doesn't reject.
const maxAreaLen = 60

func NormalizeArea(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > maxAreaLen {
		return strings.TrimSpace(s[:maxAreaLen])
	}
	return s
}

// ReportTaxonomy is what GET /reports/taxonomy answers: the closed sets a
// client may offer, straight from the constants above.
type ReportTaxonomy struct {
	Categories []ReportCategory `json:"categories"`
	Priorities []ReportPriority `json:"priorities"`
}

// ReportEventTarget is everything an emitted event needs, in one lookup: who
// to scope the live stream to, what to name the report, and where (if
// anywhere) to POST it.
type ReportEventTarget struct {
	OrgID         string
	ProjectID     string
	Folio         string
	WebhookURL    string
	WebhookSecret string
}

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
	// Platform distinguishes a browser project ("web": widget reports, Origin/CORS
	// enforced) from a native app project ("app": headless telemetry, no Origin
	// guard). Defaults to "web" for every pre-existing project.
	Platform string `gorm:"type:varchar(10);default:'web'" json:"platform"`
	// DefaultAssigneeUserID: new reports are born assigned to this agent
	// (portento's DEFAULT_ASSIGNEE_ID behavior).
	DefaultAssigneeUserID *string `gorm:"type:varchar(36)" json:"defaultAssigneeUserId,omitempty"`
	// Outbound webhook, per project so each tenant only ever receives its own
	// events. The secret signs the body; it is write-only, like the ingest key.
	WebhookURL    string `gorm:"type:text"          json:"webhookUrl"`
	WebhookSecret string `gorm:"type:varchar(120)"  json:"-"`
}

// Report is a single bug report. seq is a short per-project folio (PROJ-123).
type Report struct {
	BaseModel
	ProjectID   string       `gorm:"type:varchar(36);index;not null" json:"projectId"`
	Seq         int          `gorm:"not null"                        json:"seq"`
	Title       string       `gorm:"type:varchar(200);not null"      json:"title"`
	Description string       `gorm:"type:text"                       json:"description"`
	Status      ReportStatus `gorm:"type:varchar(20);default:'pending'" json:"status"`
	// Taxonomy — see the block above for why category/priority are closed sets
	// and area is free text.
	Category ReportCategory `gorm:"type:varchar(20);default:'other';index"  json:"category"`
	Priority ReportPriority `gorm:"type:varchar(10);default:'medium';index" json:"priority"`
	Area     string         `gorm:"type:varchar(60)"                       json:"area"`
	// Origin: 'user' (widget/portal) | 'system' (automated reports, deduped by
	// title against open reports of the same project).
	Origin           string     `gorm:"type:varchar(10);default:'user'" json:"origin"`
	URL              string     `gorm:"type:text"                       json:"url"`
	UserAgent        string     `gorm:"type:text"                       json:"userAgent"`
	Viewport         string     `gorm:"type:varchar(50)"                json:"viewport"`
	Telemetry        []byte     `gorm:"type:bytea"                      json:"-"` // AES-GCM blob (decision 7)
	TelemetryPurgeAt *time.Time `json:"telemetryPurgeAt,omitempty"`
	ReporterName     string     `gorm:"type:varchar(120)"               json:"reporterName"`
	ReporterEmail    string     `gorm:"type:varchar(255)"               json:"reporterEmail"`
	// ReporterID is the host app's own user id (from its session), passed by the
	// widget's reporter() callback. Indexed for the future "my reports" view.
	ReporterID     string         `gorm:"type:varchar(255);index"         json:"reporterId"`
	AssigneeUserID *string        `gorm:"type:varchar(36);index"          json:"assigneeUserId,omitempty"`
	ResolvedAt     *time.Time     `json:"resolvedAt,omitempty"`
	DeletedAt      gorm.DeletedAt `gorm:"index"                           json:"-"`
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
	OrgID                 string   `json:"orgId"                 validate:"required"`
	Name                  string   `json:"name"                  validate:"required,min=1,max=120"`
	Slug                  string   `json:"slug"                  validate:"omitempty,min=1,max=120"`
	Platform              string   `json:"platform"              validate:"omitempty,oneof=web app"`
	AllowedOrigins        []string `json:"allowedOrigins"        validate:"omitempty,dive,url"`
	RateLimitPerHour      int      `json:"rateLimitPerHour"      validate:"omitempty,min=1,max=10000"`
	DefaultAssigneeUserID string   `json:"defaultAssigneeUserId" validate:"omitempty,uuid4"`
	WebhookURL            string   `json:"webhookUrl"            validate:"omitempty,url"`
	WebhookSecret         string   `json:"webhookSecret"         validate:"omitempty,min=16,max=120"`
}

type UpdateReportProjectRequest struct {
	Name             string   `json:"name"             validate:"required,min=1,max=120"`
	AllowedOrigins   []string `json:"allowedOrigins"   validate:"omitempty,dive,url"`
	RateLimitPerHour int      `json:"rateLimitPerHour" validate:"omitempty,min=1,max=10000"`
	IsActive         *bool    `json:"isActive"`
	// "" clears the default assignee; a uuid sets it.
	DefaultAssigneeUserID string `json:"defaultAssigneeUserId" validate:"omitempty,uuid4"`
	// "" clears the webhook. The secret is only replaced when a new one is
	// sent, so an ordinary edit doesn't silently wipe it.
	WebhookURL    string `json:"webhookUrl"    validate:"omitempty,url"`
	WebhookSecret string `json:"webhookSecret" validate:"omitempty,min=16,max=120"`
}

type ReportProjectResponse struct {
	ID                    string   `json:"id"`
	OrgID                 string   `json:"orgId"`
	Name                  string   `json:"name"`
	Slug                  string   `json:"slug"`
	Platform              string   `json:"platform"`
	AllowedOrigins        []string `json:"allowedOrigins"`
	RateLimitPerHour      int      `json:"rateLimitPerHour"`
	IsActive              bool     `json:"isActive"`
	DefaultAssigneeUserID *string  `json:"defaultAssigneeUserId,omitempty"`
	WebhookURL            string   `json:"webhookUrl"`
	// Whether a secret is set — never the value.
	WebhookConfigured bool      `json:"webhookConfigured"`
	CreatedAt         time.Time `json:"createdAt"`
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
	ReporterID    string // host app's own user id (from reporter() callback)
	Origin        string // "" / "user" | "system" (system reports dedup by title)
	Category      string // normalized; unknown or empty becomes "other"
	Priority      string // normalized; unknown or empty becomes "medium"
	Area          string // free text, trimmed to 60 chars
	// Raw JSON strings from the widget (decision 4/7). Combined, server-redacted
	// and AES-GCM encrypted into reports.telemetry.
	TelemetryJSON string
	SnapshotJSON  string
	ContextJSON   string
	Images        []IngestImage
}

// IngestReportResult is the compact confirmation returned to the widget.
type IngestReportResult struct {
	ID     string `json:"id"`
	Seq    int    `json:"seq"`
	Folio  string `json:"folio"` // <project-slug>-<seq>
	Images int    `json:"images"`
	// Token is the per-report reporter token — the widget stores it so the
	// reporter can follow up (see status, read replies, respond). No email/login.
	Token string `json:"token"`
	// Deduped: a system report matched an open report with the same title; the
	// existing report is returned instead of creating a duplicate.
	Deduped bool `json:"deduped,omitempty"`
}

// UnreadRequest is the batch unread-count check the widget polls (one request
// for all the reporter's stored reports). since = unix seconds of last-seen.
type UnreadRequest struct {
	Items []UnreadItem `json:"items"`
}
type UnreadItem struct {
	ID    string `json:"id"`
	Token string `json:"token"`
	Since int64  `json:"since"`
}

// ─── Reporter-facing views (token-scoped, no internal fields) ─────────────────

type ReporterCommentView struct {
	Author    string                `json:"author"` // "you" | "team" | "system"
	Body      string                `json:"body"`
	Images    []ReportImageResponse `json:"images,omitempty"`
	CreatedAt time.Time             `json:"createdAt"`
}

// ReporterReportView is the reporter's own view of their report: status + the
// conversation. Deliberately omits telemetry, user agent, assignee and other
// reporters' data.
type ReporterReportView struct {
	ID          string                `json:"id"`
	Folio       string                `json:"folio"`
	Title       string                `json:"title"`
	Description string                `json:"description"`
	Status      ReportStatus          `json:"status"`
	CreatedAt   time.Time             `json:"createdAt"`
	UpdatedAt   time.Time             `json:"updatedAt"`
	Images      []ReportImageResponse `json:"images"`
	Comments    []ReporterCommentView `json:"comments"`
}

// ─── Requests / Responses (reports admin) ─────────────────────────────────────

// ReportListQuery holds the GET /reports filters (all optional).
type ReportListQuery struct {
	ProjectID  string
	Status     ReportStatus
	Category   ReportCategory
	Priority   ReportPriority
	AssigneeID string
	// ReporterID is the host app's own user id, as passed to ingest. It's what
	// lets a tenant build a "my reports" view without cac keeping a per-user
	// index: the caller already has the id from its own session.
	ReporterID string
	From       *time.Time
	To         *time.Time
	Limit      int
	Offset     int
}

type ReportListItem struct {
	ID             string         `json:"id"`
	ProjectID      string         `json:"projectId"`
	ProjectSlug    string         `json:"projectSlug"`
	ProjectName    string         `json:"projectName"`
	Seq            int            `json:"seq"`
	Folio          string         `json:"folio" gorm:"-"`
	Title          string         `json:"title"`
	Status         ReportStatus   `json:"status"`
	Category       ReportCategory `json:"category"`
	Priority       ReportPriority `json:"priority"`
	Area           string         `json:"area"`
	Origin         string         `json:"origin"`
	ReporterName   string         `json:"reporterName"`
	ReporterEmail  string         `json:"reporterEmail"`
	ReporterID     string         `json:"reporterId"`
	AssigneeUserID *string        `json:"assigneeUserId,omitempty"`
	AssigneeName   string         `json:"assigneeName,omitempty"`
	ImageCount     int            `json:"imageCount"` // gallery only (comment_id IS NULL)
	CommentCount   int            `json:"commentCount"`
	CreatedAt      time.Time      `json:"createdAt"`
	UpdatedAt      time.Time      `json:"updatedAt"`
	ResolvedAt     *time.Time     `json:"resolvedAt,omitempty"`
}

type ReportListResult struct {
	Items  []ReportListItem `json:"items"`
	Total  int64            `json:"total"`
	Limit  int              `json:"limit"`
	Offset int              `json:"offset"`
}

// UpdateReportRequest: nil field = no change. AssigneeUserID "" = unassign.
type UpdateReportRequest struct {
	// Both vocabularies are listed on purpose — see statusAliases. The handler
	// folds the value before it reaches the service, so nothing downstream has
	// to know two names for the same state.
	Status         *ReportStatus `json:"status" validate:"omitempty,oneof=pending in_progress resolved closed open done"`
	AssigneeUserID *string       `json:"assigneeUserId"` // "" unassigns
	// Triage fields. Unlike status they have no state machine — any value in
	// the set is reachable from any other.
	Category *ReportCategory `json:"category" validate:"omitempty,oneof=bug ui performance data other"`
	Priority *ReportPriority `json:"priority" validate:"omitempty,oneof=low medium high urgent"`
	Area     *string         `json:"area"`
}

type ReportCommentResponse struct {
	ID           string                `json:"id"`
	Kind         ReportCommentKind     `json:"kind"`
	AuthorUserID *string               `json:"authorUserId,omitempty"`
	AuthorName   string                `json:"authorName,omitempty"`
	Body         string                `json:"body"`
	Images       []ReportImageResponse `json:"images,omitempty" gorm:"-"`
	CreatedAt    time.Time             `json:"createdAt"`
	UpdatedAt    time.Time             `json:"updatedAt"`
}

type UpdateReportCommentRequest struct {
	Body string `json:"body" validate:"required,min=1"`
}

type ReportImageResponse struct {
	ID        string    `json:"id"`
	CommentID *string   `json:"commentId,omitempty"`
	FileName  string    `json:"fileName"`
	URL       string    `json:"url"` // short-lived HMAC-signed proxy URL
	CreatedAt time.Time `json:"createdAt"`
}

type ReportDetailResponse struct {
	ID             string                  `json:"id"`
	ProjectID      string                  `json:"projectId"`
	ProjectSlug    string                  `json:"projectSlug"`
	Seq            int                     `json:"seq"`
	Folio          string                  `json:"folio"`
	Title          string                  `json:"title"`
	Description    string                  `json:"description"`
	Status         ReportStatus            `json:"status"`
	Category       ReportCategory          `json:"category"`
	Priority       ReportPriority          `json:"priority"`
	Area           string                  `json:"area"`
	Origin         string                  `json:"origin"`
	URL            string                  `json:"url"`
	UserAgent      string                  `json:"userAgent"`
	Viewport       string                  `json:"viewport"`
	ReporterName   string                  `json:"reporterName"`
	ReporterEmail  string                  `json:"reporterEmail"`
	ReporterID     string                  `json:"reporterId"`
	AssigneeUserID *string                 `json:"assigneeUserId,omitempty"`
	ResolvedAt     *time.Time              `json:"resolvedAt,omitempty"`
	CreatedAt      time.Time               `json:"createdAt"`
	UpdatedAt      time.Time               `json:"updatedAt"`
	Images         []ReportImageResponse   `json:"images"` // gallery (comment_id IS NULL)
	Comments       []ReportCommentResponse `json:"comments"`
	// Telemetry is the decrypted breadcrumbs blob ({telemetry,snapshot,context}),
	// null when none was captured or it has been purged. Only in the detail view.
	Telemetry json.RawMessage `json:"telemetry,omitempty"`
}
