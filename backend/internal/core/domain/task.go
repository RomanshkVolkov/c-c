package domain

import (
	"strings"
	"time"
)

// ─── Hierarchy ────────────────────────────────────────────────────────────────
//
// Org → Space → (Folder) → List → Task. Folders are optional: a list can hang
// straight off a space. Ordering everywhere uses fractional ranks (see
// core/rank) so moving one item is a single-row update.

type TaskSpace struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	Name  string `gorm:"type:varchar(120);not null"      json:"name"`
	Color string `gorm:"type:varchar(20)"                json:"color"`
	Rank  string `gorm:"type:varchar(64);index"          json:"-"`
	// ProjectID binds everything under this space to a tenant's channel, unless a
	// list below says otherwise. Set here when a whole space is one client's work.
	ProjectID *string `gorm:"type:varchar(36);index" json:"projectId,omitempty"`
}

type TaskFolder struct {
	BaseModel
	SpaceID string `gorm:"type:varchar(36);index;not null" json:"spaceId"`
	Name    string `gorm:"type:varchar(120);not null"      json:"name"`
	Rank    string `gorm:"type:varchar(64);index"          json:"-"`
}

type TaskList struct {
	BaseModel
	SpaceID string `gorm:"type:varchar(36);index;not null" json:"spaceId"`
	// FolderID nil = the list sits directly under the space.
	FolderID *string `gorm:"type:varchar(36);index" json:"folderId,omitempty"`
	Name     string  `gorm:"type:varchar(120);not null" json:"name"`
	Rank     string  `gorm:"type:varchar(64);index"     json:"-"`
	// ProjectID binds this list to a tenant's channel and overrides the space's.
	//
	// Which way this points matters. It used to be the project that named its
	// list, and the migration had to guess one — it invented a "Reportes" space
	// per organization when portento already had a home of its own. Naming the
	// channel from the node you are looking at puts that choice where the person
	// making it can see the tree.
	ProjectID *string `gorm:"type:varchar(36);index" json:"projectId,omitempty"`
}

// ─── Board columns ────────────────────────────────────────────────────────────

// TaskStatusKind drives behaviour that shouldn't depend on a column's name:
// which column new tasks land in, and what counts as finished.
type TaskStatusKind string

const (
	StatusKindOpen   TaskStatusKind = "open"   // backlog / not started
	StatusKindActive TaskStatusKind = "active" // in progress
	StatusKindDone   TaskStatusKind = "done"   // closed
)

// TaskStatus is one board column, configurable per list — that's what makes the
// workflow yours instead of a fixed state machine like reports use.
type TaskStatus struct {
	BaseModel
	ListID string         `gorm:"type:varchar(36);index;not null" json:"listId"`
	Name   string         `gorm:"type:varchar(60);not null"       json:"name"`
	Color  string         `gorm:"type:varchar(20)"                json:"color"`
	Kind   TaskStatusKind `gorm:"type:varchar(20);default:'open'" json:"kind"`
	Rank   string         `gorm:"type:varchar(64);index"          json:"-"`
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

type TaskPriority string

const (
	PriorityNone   TaskPriority = "none"
	PriorityLow    TaskPriority = "low"
	PriorityNormal TaskPriority = "normal"
	PriorityHigh   TaskPriority = "high"
	PriorityUrgent TaskPriority = "urgent"
)

func (p TaskPriority) IsValid() bool {
	switch p {
	case PriorityNone, PriorityLow, PriorityNormal, PriorityHigh, PriorityUrgent:
		return true
	}
	return false
}

type Task struct {
	BaseModel
	ListID   string `gorm:"type:varchar(36);index;not null" json:"listId"`
	StatusID string `gorm:"type:varchar(36);index;not null" json:"statusId"`
	// OrgID is denormalized from the list's space so every scoping query and the
	// board filters stay single-table.
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// Seq is a short human folio within the space (SPACE-12).
	Seq   int    `gorm:"not null"                    json:"seq"`
	Title string `gorm:"type:varchar(300);not null"  json:"title"`
	// Description is markdown — the source of truth, so it stays readable by
	// anything (exports, the MCP server) and not just the editor that wrote it.
	Description string       `gorm:"type:text"                        json:"description"`
	Priority    TaskPriority `gorm:"type:varchar(20);default:'none'"  json:"priority"`
	// Set only for tasks created with an idempotency key; unique per list.
	IdempotencyKey string     `gorm:"type:varchar(120);index" json:"-"`
	Rank           string     `gorm:"type:varchar(64);index"           json:"-"`
	StartAt        *time.Time `json:"startAt,omitempty"`
	DueAt          *time.Time `gorm:"index" json:"dueAt,omitempty"`
	CompletedAt    *time.Time `json:"completedAt,omitempty"`
	CreatedByID    string     `gorm:"type:varchar(36)" json:"createdById"`
	// ParentID makes this a subtask of another task. Subtasks live in the same
	// list and share its columns; they're hidden from the board's top level so a
	// parent's breakdown doesn't clutter the column it belongs to.
	ParentID   *string    `gorm:"type:varchar(36);index" json:"parentId,omitempty"`
	ArchivedAt *time.Time `gorm:"index" json:"archivedAt,omitempty"`
}

// TaskTag is an org-wide label pool, so tags stay consistent across spaces.
type TaskTag struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null;uniqueIndex:idx_tag_org_name" json:"orgId"`
	Name  string `gorm:"type:varchar(60);not null;uniqueIndex:idx_tag_org_name"       json:"name"`
	Color string `gorm:"type:varchar(20)" json:"color"`
}

type TaskTagLink struct {
	TaskID string `gorm:"type:varchar(36);primaryKey" json:"taskId"`
	TagID  string `gorm:"type:varchar(36);primaryKey" json:"tagId"`
}

type TaskAssignee struct {
	TaskID string `gorm:"type:varchar(36);primaryKey" json:"taskId"`
	UserID string `gorm:"type:varchar(36);primaryKey" json:"userId"`
}

type TaskComment struct {
	BaseModel
	TaskID       string `gorm:"type:varchar(36);index;not null" json:"taskId"`
	AuthorUserID string `gorm:"type:varchar(36)"                json:"authorUserId"`
	Body         string `gorm:"type:text"                       json:"body"` // markdown
}

// TaskAttachment points at a file stored through image-service. CommentID set =
// attached to a comment; nil = attached to the task itself. Files referenced
// inline from markdown are recorded here too, so nothing is orphaned.
type TaskAttachment struct {
	BaseModel
	TaskID    string  `gorm:"type:varchar(36);index;not null" json:"taskId"`
	CommentID *string `gorm:"type:varchar(36);index"          json:"commentId,omitempty"`
	// URL is the path clients fetch: our own authenticated proxy, not the
	// bucket. The bucket denies anonymous reads, so an <img> pointed straight at
	// it renders nothing at all (which is what happened to inline images).
	URL string `gorm:"type:text;not null" json:"url"`
	// Path is the object key inside the bucket. Never exposed: it is the thing
	// the proxy needs and the client must not be able to address directly.
	Path        string `gorm:"type:text"                       json:"-"`
	FileName    string `gorm:"type:varchar(255)"               json:"fileName"`
	ContentType string `gorm:"type:varchar(120)"               json:"contentType"`
	Bytes       int64  `json:"bytes"`
	UploadedBy  string `gorm:"type:varchar(36)" json:"uploadedBy"`
}

// AttachmentRef is the canonical reference stored in markdown and returned to
// clients: our own proxy, relative so the same description resolves against
// whichever backend the app is pointed at.
func AttachmentRef(taskID, attachmentID string) string {
	return "/api/v1/tasks/" + taskID + "/attachments/" + attachmentID + "/raw"
}

// NormalizeURL points an attachment at the proxy. Rows written before the proxy
// existed hold the bucket URL, which no client can load (the bucket denies
// anonymous reads) — this makes those rows serve like new ones.
func (a *TaskAttachment) NormalizeURL() {
	if !strings.HasPrefix(a.URL, "/api/") {
		a.URL = AttachmentRef(a.TaskID, a.ID)
	}
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

// DocOwnerKind is the node a document describes. One document per node: the
// "overview" of a space, a folder or a list. A multi-page tree can be layered on
// top later without moving these rows.
type DocOwnerKind string

const (
	DocOwnerSpace  DocOwnerKind = "space"
	DocOwnerFolder DocOwnerKind = "folder"
	DocOwnerList   DocOwnerKind = "list"
)

func ValidDocOwnerKind(k string) bool {
	switch DocOwnerKind(k) {
	case DocOwnerSpace, DocOwnerFolder, DocOwnerList:
		return true
	}
	return false
}

type Doc struct {
	BaseModel
	// Denormalized so authorization and listing don't have to walk the tree.
	OrgID     string       `gorm:"type:varchar(36);index;not null"                json:"orgId"`
	OwnerKind DocOwnerKind `gorm:"type:varchar(20);not null;index:idx_doc_owner,unique" json:"ownerKind"`
	OwnerID   string       `gorm:"type:varchar(36);not null;index:idx_doc_owner,unique" json:"ownerId"`
	// Markdown, same format tasks use, so one editor and one renderer serve both.
	Body          string `gorm:"type:text" json:"body"`
	UpdatedBy     string `gorm:"type:varchar(36)" json:"updatedBy"`
	UpdatedByName string `gorm:"-" json:"updatedByName,omitempty"`
}

// DocAttachment is a file cited from a document.
//
// Kept apart from TaskAttachment instead of making that table polymorphic: the
// task one is live in production with rows whose URLs are already written inside
// saved markdown, and loosening its NOT NULL task_id is a migration this feature
// doesn't need. The streaming and authorization code is shared.
type DocAttachment struct {
	BaseModel
	DocID       string `gorm:"type:varchar(36);index;not null" json:"docId"`
	URL         string `gorm:"type:text;not null"              json:"url"`
	Path        string `gorm:"type:text"                       json:"-"`
	FileName    string `gorm:"type:varchar(255)"               json:"fileName"`
	ContentType string `gorm:"type:varchar(120)"               json:"contentType"`
	Bytes       int64  `json:"bytes"`
	UploadedBy  string `gorm:"type:varchar(36)" json:"uploadedBy"`
}

// DocAttachmentRef mirrors AttachmentRef: relative on purpose.
func DocAttachmentRef(docID, attachmentID string) string {
	return "/api/v1/docs/" + docID + "/attachments/" + attachmentID + "/raw"
}

func (a *DocAttachment) NormalizeURL() {
	if !strings.HasPrefix(a.URL, "/api/") {
		a.URL = DocAttachmentRef(a.DocID, a.ID)
	}
}

type SaveDocRequest struct {
	Body string `json:"body"`
}

// ─── Requests ─────────────────────────────────────────────────────────────────

type CreateSpaceRequest struct {
	OrgID string `json:"orgId" validate:"required"`
	Name  string `json:"name"  validate:"required,min=1,max=120"`
	Color string `json:"color" validate:"omitempty,max=20"`
}

type RenameRequest struct {
	Name  string `json:"name"  validate:"required,min=1,max=120"`
	Color string `json:"color" validate:"omitempty,max=20"`
}

type CreateFolderRequest struct {
	Name string `json:"name" validate:"required,min=1,max=120"`
}

type CreateListRequest struct {
	Name     string  `json:"name"     validate:"required,min=1,max=120"`
	FolderID *string `json:"folderId"`
}

type CreateStatusRequest struct {
	Name  string         `json:"name" validate:"required,min=1,max=60"`
	Color string         `json:"color" validate:"omitempty,max=20"`
	Kind  TaskStatusKind `json:"kind" validate:"omitempty,oneof=open active done"`
}

type UpdateStatusRequest struct {
	Name  string         `json:"name"  validate:"required,min=1,max=60"`
	Color string         `json:"color" validate:"omitempty,max=20"`
	Kind  TaskStatusKind `json:"kind"  validate:"omitempty,oneof=open active done"`
}

type CreateTaskRequest struct {
	Title string `json:"title"    validate:"required,min=1,max=300"`
	// IdempotencyKey makes a retry safe: the same key in the same list returns
	// the task that was already created instead of a second copy. An automated
	// caller whose request times out has no other way to tell "it didn't happen"
	// from "the reply got lost".
	IdempotencyKey string `json:"idempotencyKey" validate:"omitempty,max=120"`
	// Markdown body, so a task can be filed complete in one call (the MCP tool
	// does exactly that).
	Description string       `json:"description"`
	StatusID    string       `json:"statusId"`
	Priority    TaskPriority `json:"priority" validate:"omitempty,oneof=none low normal high urgent"`
	// ParentID creates this task as a subtask of another one.
	ParentID string `json:"parentId"`
}

// UpdateTaskRequest patches a task; nil fields are left untouched so the client
// can send just what changed.
type UpdateTaskRequest struct {
	Title       *string       `json:"title"       validate:"omitempty,min=1,max=300"`
	Description *string       `json:"description"`
	Priority    *TaskPriority `json:"priority"    validate:"omitempty,oneof=none low normal high urgent"`
	StartAt     *time.Time    `json:"startAt"`
	DueAt       *time.Time    `json:"dueAt"`
	// Nil leaves membership alone; an empty slice clears it.
	TagIDs      *[]string `json:"tagIds"`
	AssigneeIDs *[]string `json:"assigneeIds"`
	Archived    *bool     `json:"archived"`
}

// MoveTaskRequest places a task between two neighbours in a column. The server
// derives the rank, so clients never compute ordering.
type MoveTaskRequest struct {
	StatusID string `json:"statusId" validate:"required"`
	AfterID  string `json:"afterId"`  // task it should follow (empty = top)
	BeforeID string `json:"beforeId"` // task it should precede (empty = bottom)
}

// MoveNodeRequest reorders a space/folder/list among its siblings.
type MoveNodeRequest struct {
	AfterID  string `json:"afterId"`
	BeforeID string `json:"beforeId"`
	// FolderID only applies to lists: moving one into (or out of) a folder.
	FolderID *string `json:"folderId"`
}

type CreateTagRequest struct {
	OrgID string `json:"orgId" validate:"required"`
	Name  string `json:"name"  validate:"required,min=1,max=60"`
	Color string `json:"color" validate:"omitempty,max=20"`
}

type TaskCommentRequest struct {
	Body string `json:"body" validate:"required,min=1"`
}

// ─── Responses ────────────────────────────────────────────────────────────────

// SpaceTree is the whole left-hand navigator in one round-trip.
type SpaceTree struct {
	ID      string        `json:"id"`
	OrgID   string        `json:"orgId"`
	Name    string        `json:"name"`
	Color   string        `json:"color"`
	Folders []FolderTree  `json:"folders"`
	Lists   []ListSummary `json:"lists"` // lists directly under the space
}

type FolderTree struct {
	ID    string        `json:"id"`
	Name  string        `json:"name"`
	Lists []ListSummary `json:"lists"`
}

type ListSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	TaskCount int64  `json:"taskCount"`
}

type TaskCard struct {
	ID              string       `json:"id"`
	Seq             int          `json:"seq"`
	Title           string       `json:"title"`
	Priority        TaskPriority `json:"priority"`
	StatusID        string       `json:"statusId"`
	DueAt           *time.Time   `json:"dueAt,omitempty"`
	HasDescription  bool         `json:"hasDescription"`
	CommentCount    int64        `json:"commentCount"`
	AttachmentCount int64        `json:"attachmentCount"`
	// Subtask progress, so a card shows its breakdown without being opened.
	SubtaskCount int64         `json:"subtaskCount"`
	SubtaskDone  int64         `json:"subtaskDone"`
	Tags         []TaskTag     `json:"tags"`
	Assignees    []UserSummary `json:"assignees"`
	UpdatedAt    time.Time     `json:"updatedAt"`
}

type BoardResponse struct {
	List     ListSummary  `json:"list"`
	Statuses []TaskStatus `json:"statuses"`
	Tasks    []TaskCard   `json:"tasks"`
}

// OpenTask is one line of the dashboard's "what's pending" list: enough to
// recognise a task and jump to it, and no more.
//
// Deliberately not a TaskCard. That one carries tags, comment and attachment
// counts and subtask progress — four extra queries per board — which is right
// for a board you work in and wasteful for a summary you glance at. It also
// crosses lists, which the board never does, so it names the list and space a
// task came from.
type OpenTask struct {
	ID         string         `json:"id"`
	Seq        int            `json:"seq"`
	Title      string         `json:"title"`
	Priority   TaskPriority   `json:"priority"`
	DueAt      *time.Time     `json:"dueAt,omitempty"`
	StatusName string         `json:"statusName"`
	StatusKind TaskStatusKind `json:"statusKind"`
	ListID     string         `json:"listId"`
	ListName   string         `json:"listName"`
	SpaceID    string         `json:"spaceId"`
	SpaceName  string         `json:"spaceName"`
	UpdatedAt  time.Time      `json:"updatedAt"`
}

type TaskCommentResponse struct {
	ID           string           `json:"id"`
	AuthorUserID string           `json:"authorUserId"`
	AuthorName   string           `json:"authorName"`
	Body         string           `json:"body"`
	Attachments  []TaskAttachment `json:"attachments"`
	CreatedAt    time.Time        `json:"createdAt"`
	UpdatedAt    time.Time        `json:"updatedAt"`
}

type TaskDetail struct {
	Task        Task                  `json:"task"`
	ListName    string                `json:"listName"`
	SpaceName   string                `json:"spaceName"`
	Status      TaskStatus            `json:"status"`
	Tags        []TaskTag             `json:"tags"`
	Assignees   []UserSummary         `json:"assignees"`
	Comments    []TaskCommentResponse `json:"comments"`
	Attachments []TaskAttachment      `json:"attachments"`
	Subtasks    []TaskCard            `json:"subtasks"`
	/** Set when this task is itself a subtask, so the drawer can link back. */
	Parent *TaskCard `json:"parent,omitempty"`
}
