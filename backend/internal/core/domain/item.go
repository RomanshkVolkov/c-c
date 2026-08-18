package domain

import (
	"time"

	"gorm.io/gorm"
)

// ─── The unified work item ────────────────────────────────────────────────────
//
// A report and a task were the same thing held a metre apart: work on a board.
// What actually differed was **where the work came from** and **who can read the
// conversation**. Everything else — title, markdown description, state,
// priority, assignees, comments, attachments — was written twice, and paid for
// twice (the draft-loss bug was fixed once per module; so was live refresh).
//
// So: one table, one state machine, one comment thread.
//
//   - An item with a ProjectID came in through a tenant's channel. It has a
//     reporter, a public folio, and its own webhook. That is a "report".
//   - An item without one was raised inside cac. That is a "task".
//
// ProjectID is a plain string with "" meaning "no channel", not a *string.
// Nullable would read better in isolation, but the contract test builds these
// rows as Go structs and a zero value has to mean something valid.
//
// Nothing reads this table yet. It is populated in the dark, verified against
// the old tables, and only then switched over — one channel at a time.

// ItemPriority is the union of the two scales that existed.
//
// Reports had low/medium/high/urgent, asked at triage rather than at capture
// (ask a reporter and everything comes back urgent). Tasks had
// none/low/normal/high/urgent, where "none" means nobody has decided yet — a
// real and useful state for internal work, and one a report never needs because
// ingest always assigns a default.
//
// `normal` and `medium` were the same rung with two names. The stored vocabulary
// keeps `medium`; `normal` survives as an accepted input and as what the task
// API answers, exactly the way statusAliases handles the report vocabulary.
type ItemPriority string

const (
	ItemPriorityNone   ItemPriority = "none"
	ItemPriorityLow    ItemPriority = "low"
	ItemPriorityMedium ItemPriority = "medium"
	ItemPriorityHigh   ItemPriority = "high"
	ItemPriorityUrgent ItemPriority = "urgent"
)

// itemPriorityAliases folds an accepted spelling onto the stored one. Only this
// map changes direction if the wire vocabulary is ever unified.
var itemPriorityAliases = map[ItemPriority]ItemPriority{
	"normal": ItemPriorityMedium,
}

// ItemPriorities is ordered none → urgent; clients render them in this order.
func ItemPriorities() []ItemPriority {
	return []ItemPriority{
		ItemPriorityNone, ItemPriorityLow, ItemPriorityMedium, ItemPriorityHigh, ItemPriorityUrgent,
	}
}

// Canonical folds an accepted alias onto the stored vocabulary. An unrecognised
// value comes back unchanged so IsValid still rejects it.
func (p ItemPriority) Canonical() ItemPriority {
	if c, ok := itemPriorityAliases[p]; ok {
		return c
	}
	return p
}

func (p ItemPriority) IsValid() bool {
	c := p.Canonical()
	for _, known := range ItemPriorities() {
		if c == known {
			return true
		}
	}
	return false
}

// TaskWire spells a priority the way the task API has always answered it.
//
// The desktop app is installed and updated by hand, so a build from last month
// is still asking. It switches on the literal `normal`; answering `medium`
// would leave those cards with a priority the UI can't label.
func (p ItemPriority) TaskWire() ItemPriority {
	if p.Canonical() == ItemPriorityMedium {
		return "normal"
	}
	return p.Canonical()
}

// ReportWire spells a priority the way the report contract promises.
//
// That contract has four values and no "none": a tenant's board has no column
// for "undecided". An item that picked up `none` from the internal side is
// answered as `medium`, which is the value ingest would have given it anyway.
func (p ItemPriority) ReportWire() ItemPriority {
	if c := p.Canonical(); c != ItemPriorityNone {
		return c
	}
	return ItemPriorityMedium
}

// ItemVisibility is who may read a comment. The distinction the two modules
// used to draw with two separate tables.
type ItemVisibility string

const (
	// VisibilityInternal never leaves cac: not to the reporter, not to the
	// tenant's API, not down the webhook, not into the reporter's unread count.
	// It is what a task comment always was.
	VisibilityInternal ItemVisibility = "internal"
	// VisibilityPublic is part of the conversation with whoever filed the item.
	// It is what a report comment always was, and it triggers the webhook.
	VisibilityPublic ItemVisibility = "public"
)

func (v ItemVisibility) IsValid() bool {
	return v == VisibilityInternal || v == VisibilityPublic
}

// Item is one piece of work.
//
// Field names deliberately match Report's where they overlap: the contract test
// constructs those structs directly, so at cutover `Report` can become an alias
// of this type instead of a rewrite of the test.
type Item struct {
	BaseModel
	// OrgID is denormalised from whatever owns the item, because every scoping
	// check and every board filter reads it — as tasks already did.
	OrgID string `gorm:"type:varchar(36);index" json:"orgId"`
	// The container. One tree (space → folder → list) holds everything, so a
	// report can be dragged around a board like anything else.
	//
	// SpaceID is denormalised too, and it earns its keep twice: it scopes the
	// internal numbering without a join, and it keeps the report-facing queries
	// from touching task tables at all — which they cannot do, because the
	// contract test runs against a database where those tables don't exist.
	ListID  string `gorm:"type:varchar(36);index" json:"listId"`
	SpaceID string `gorm:"type:varchar(36);index" json:"spaceId"`
	// ProjectID is the channel the item arrived through. "" = raised inside cac.
	// It decides the numbering scope, which events fire, and what a tenant sees.
	ProjectID string `gorm:"type:varchar(36);index" json:"projectId"`
	// Seq is the human-facing number. Scoped per project for channel items (so
	// the folio `acme-7` keeps meaning what it meant) and per space for internal
	// ones. Two partial unique indexes keep both honest — see db.go.
	Seq int `gorm:"not null;default:0" json:"seq"`
	// 300, the wider of the two. The report side still refuses more than 200 on
	// input: the column got roomier, the promise didn't.
	Title       string `gorm:"type:varchar(300);not null" json:"title"`
	Description string `gorm:"type:text"                  json:"description"`
	// One state machine for everything. The configurable per-list columns are
	// gone; what they were really carrying was their `kind`, which maps onto
	// these four.
	Status   ReportStatus   `gorm:"type:varchar(20);default:'pending';index" json:"status"`
	Category ReportCategory `gorm:"type:varchar(20);default:'other';index"   json:"category"`
	Priority ItemPriority   `gorm:"type:varchar(10);default:'none';index"    json:"priority"`
	Area     string         `gorm:"type:varchar(60)"                        json:"area"`
	// Origin: 'user' (a person outside), 'system' (automated, deduped by title),
	// 'internal' (raised in cac).
	Origin string `gorm:"type:varchar(10);default:'user'" json:"origin"`

	// ── Only ever set on a channel item ──
	URL              string     `gorm:"type:text"        json:"url"`
	UserAgent        string     `gorm:"type:text"        json:"userAgent"`
	Viewport         string     `gorm:"type:varchar(50)" json:"viewport"`
	Telemetry        []byte     `gorm:"type:bytea"       json:"-"` // AES-GCM blob
	TelemetryPurgeAt *time.Time `json:"telemetryPurgeAt,omitempty"`
	ReporterName     string     `gorm:"type:varchar(120)" json:"reporterName"`
	ReporterEmail    string     `gorm:"type:varchar(255)" json:"reporterEmail"`
	// ReporterID is the host app's own user id, asserted by the tenant. Indexed
	// for "my reports".
	ReporterID string `gorm:"type:varchar(255);index" json:"reporterId"`
	// AssigneeUserID is who is responsible. One person, because that is what the
	// report contract has always exposed and what a tenant reads.
	//
	// Tasks keep their own many-to-many table, unchanged: it works, and nobody
	// asked for several owners on a report. An extra "assignees" table here would
	// have been a third place the same fact lives.
	AssigneeUserID *string `gorm:"type:varchar(36);index" json:"assigneeUserId,omitempty"`
	// Visibility is whether the channel's owner actually sees this, and it is a
	// separate question from ProjectID on purpose.
	//
	// ProjectID says whose numbering the item uses. Visibility says whether they
	// see it. Deriving one from the other looked simpler until retracting a
	// published item cleared its channel — and the next one was handed the same
	// folio, which is the collision this codebase already fixed once today.
	//
	// So a retracted item keeps its channel and its spent number, and stops being
	// listed. The client's numbering keeps a gap, which is the truth.
	Visibility ItemVisibility `gorm:"type:varchar(10);default:'public';index" json:"visibility"`

	// ── From the task side, now available to everything ──
	// Rank orders the board by hand. Fractional, so moving one card is one
	// UPDATE — see core/rank. Never sent to a client: it computes no order.
	Rank string `gorm:"type:varchar(64);index" json:"-"`
	// IdempotencyKey is unique per list, via a partial index (the empty string
	// is the "not supplied" value and must not collide with itself).
	IdempotencyKey string     `gorm:"type:varchar(120);index" json:"-"`
	ParentID       *string    `gorm:"type:varchar(36);index"  json:"parentId,omitempty"`
	StartAt        *time.Time `json:"startAt,omitempty"`
	DueAt          *time.Time `gorm:"index" json:"dueAt,omitempty"`
	// ResolvedAt absorbs what tasks called CompletedAt, and takes the report
	// semantics: stamped on reaching a finished state and **kept** when the item
	// is reopened. Reports never cleared it — the date something was first
	// resolved is a fact, not a reflection of where the card sits now.
	ResolvedAt  *time.Time `json:"resolvedAt,omitempty"`
	CreatedByID string     `gorm:"type:varchar(36)" json:"createdById,omitempty"`
	// ArchivedAt hides an item from the internal board without deleting it. The
	// report-facing API ignores it: a tenant watching its own report must not see
	// it vanish because we tidied up, and no event would explain it.
	ArchivedAt *time.Time     `gorm:"index" json:"archivedAt,omitempty"`
	DeletedAt  gorm.DeletedAt `gorm:"index" json:"-"`
}

// IsChannel reports whether the item belongs to a tenant's channel — whose
// numbering it uses, and whose board it may appear on.
func (i *Item) IsChannel() bool { return i.ProjectID != "" }

// IsVisibleToChannel is the question the services actually ask: can the client
// see this? Belonging to a channel is not enough — a retracted item still
// belongs, because its folio is spent.
func (i *Item) IsVisibleToChannel() bool {
	return i.ProjectID != "" && i.Visibility != VisibilityInternal
}

// ItemComment is one message on an item, internal or public.
type ItemComment struct {
	BaseModel
	// Named ItemID, columned item_id. The report-facing struct keeps calling its
	// field ReportID, which is why that one carries a column tag instead.
	ItemID string            `gorm:"type:varchar(36);index;not null" json:"itemId"`
	Kind   ReportCommentKind `gorm:"type:varchar(10);default:'user'" json:"kind"`
	// Visibility is the whole point of the merge, and the one field that can
	// leak something if it's wrong.
	//
	// The column default is 'public' rather than 'internal', which is
	// fail-open — a deliberate and uncomfortable choice. The contract test
	// inserts comments as bare structs and expects the reporter to see them; a
	// fail-closed default would make it fail without anyone touching it, and
	// that test is the proof the whole migration is faithful.
	//
	// The fence is put back in code: comments are created through one
	// constructor that requires a visibility, and a test walks the source to
	// make sure nothing writes this table around it.
	Visibility ItemVisibility `gorm:"type:varchar(10);default:'public';index" json:"visibility"`
	// Authorship, three cases, one column each — never inferred from which
	// others are null. That inference broke three separate readers the first
	// time a fourth kind of author turned up.
	//
	//   AuthorUserID set    → a person with a cac account
	//   AuthorProjectID set → a person inside a tenant app. The project is
	//                         proven (by the key the comment arrived with);
	//                         the external id and name are only *asserted* by
	//                         that tenant, and must never be shown without
	//                         naming who asserted them.
	//   neither             → the reporter
	AuthorUserID       *string `gorm:"type:varchar(36)"       json:"authorUserId,omitempty"`
	AuthorProjectID    *string `gorm:"type:varchar(36);index" json:"-"`
	AuthorExternalID   string  `gorm:"type:varchar(255)"      json:"-"`
	AuthorExternalName string  `gorm:"type:varchar(120)"      json:"-"`
	Body               string  `gorm:"type:text;not null"     json:"body"`
	// Soft for everything. A task comment used to be deleted outright; keeping
	// the row changes nothing anyone can see (it stays hidden everywhere) and
	// stops the text from being destroyed.
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

// ItemAttachment merges a report's image and a task's attachment. They had
// converged already: both hang off the item, and both use a nullable comment id
// the same way.
type ItemAttachment struct {
	BaseModel
	ItemID string `gorm:"type:varchar(36);index;not null" json:"itemId"`
	// nil = belongs to the item itself (a report's gallery, a task's file list).
	// Set = posted inside that comment.
	CommentID *string `gorm:"type:varchar(36);index" json:"commentId,omitempty"`
	// Path is the storage key. Both sides have one; the report side never had
	// anything else, because its URL is signed per request and computed on read.
	Path string `gorm:"type:text" json:"-"`
	// URL is the internal proxy reference, and only internal items store one. A
	// channel item leaves this empty on purpose: persisting a URL here would
	// quietly move its bytes onto a route with different authorization.
	URL         string         `gorm:"type:text"         json:"url"`
	FileName    string         `gorm:"type:varchar(255)" json:"fileName"`
	ContentType string         `gorm:"type:varchar(120)" json:"contentType,omitempty"`
	Bytes       int64          `json:"bytes,omitempty"`
	UploadedBy  string         `gorm:"type:varchar(36)" json:"uploadedBy,omitempty"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}

// ─── The board an older app still expects ─────────────────────────────────────
//
// The desktop client is installed and updated by hand, so a build from last
// month is still asking for `BoardResponse.Statuses` and still sending the
// `statusId` it read from there. The configurable columns those rows described
// are gone; what they actually carried was their `kind`, and that maps onto the
// shared state machine.
//
// So the columns are synthesised from the four states. The client treats a
// status id as opaque — it reads one and hands it back — which is what makes a
// derived id safe here. It's the same trick statusAliases plays with the report
// vocabulary, for the same reason: the parc of installed builds is the thing
// that can't be migrated on our schedule.

// SyntheticStatusID names a column derived from a state. Prefixed with the list
// so two boards never trade ids, and parseable back with SplitSyntheticStatusID.
func SyntheticStatusID(listID string, status ReportStatus) string {
	return listID + "/" + string(status)
}

// SplitSyntheticStatusID reads a state back out of a synthetic id.
//
// Also accepts a bare state name, because a client that learns the new
// vocabulary shouldn't have to fabricate a list prefix to use it.
func SplitSyntheticStatusID(id string) (ReportStatus, bool) {
	raw := id
	if i := lastIndexByte(id, '/'); i >= 0 {
		raw = id[i+1:]
	}
	s := ReportStatus(raw).Canonical()
	if !s.IsValid() {
		return "", false
	}
	return s, true
}

func lastIndexByte(s string, b byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// boardColumns is the fixed set, in board order, with the kind an older client
// reads to decide what "done" means. Colours match what the previous defaults
// used, so a board doesn't change appearance on the day of the switch.
//
// Los nombres son los del vocabulario unificado —open / in_progress / done /
// closed— y no los que tenía el tablero antes. La primera columna se llamaba
// «To do» mientras un reporte del mismo estado decía «Open», así que el mismo
// estado se leía de dos maneras según por qué pantalla entraras. Es sólo
// rótulo: nada ramifica por él, el id sintético sale del estado.
var boardColumns = []struct {
	Status ReportStatus
	Name   string
	Color  string
	Kind   TaskStatusKind
}{
	{ReportPending, "Open", "#7D8BA3", StatusKindOpen},
	{ReportInProgress, "In progress", "#20D9E8", StatusKindActive},
	{ReportResolved, "Done", "#34D399", StatusKindDone},
	// Closed is a real state — a report can be closed without being fixed — and
	// it reads as finished to anything that groups by kind.
	{ReportClosed, "Closed", "#8B8B8B", StatusKindDone},
}

// BoardStatuses renders the fixed states as the column rows a client expects.
func BoardStatuses(listID string) []TaskStatus {
	out := make([]TaskStatus, 0, len(boardColumns))
	for _, c := range boardColumns {
		s := TaskStatus{ListID: listID, Name: c.Name, Color: c.Color, Kind: c.Kind}
		s.ID = SyntheticStatusID(listID, c.Status)
		out = append(out, s)
	}
	return out
}

// StatusKindOf answers "is this finished?" without anyone parsing a column name.
// Renaming a column was always allowed, which is why the kind existed at all.
func StatusKindOf(status ReportStatus) TaskStatusKind {
	for _, c := range boardColumns {
		if c.Status == status.Canonical() {
			return c.Kind
		}
	}
	return StatusKindOpen
}

// IsFinished is the one question most callers actually have.
func IsFinished(status ReportStatus) bool {
	return StatusKindOf(status) == StatusKindDone
}

// BoardStatusFor renders the one column a given state corresponds to.
func BoardStatusFor(listID string, status ReportStatus) TaskStatus {
	want := status.Canonical()
	for _, c := range boardColumns {
		if c.Status == want {
			s := TaskStatus{ListID: listID, Name: c.Name, Color: c.Color, Kind: c.Kind}
			s.ID = SyntheticStatusID(listID, c.Status)
			return s
		}
	}
	// Unreachable for a stored state, but a zero column would render as a blank
	// chip rather than saying anything, so name it.
	s := TaskStatus{ListID: listID, Name: string(status), Kind: StatusKindOpen}
	s.ID = SyntheticStatusID(listID, want)
	return s
}
