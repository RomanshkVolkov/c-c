package domain

// Note is a personal, privately-owned page in a nested tree — the "prescindir
// de Notion" module. Deliberately its own module rather than an extension of
// Doc (the tasks module's Overview): Doc.OrgID is NOT NULL and every check in
// its handler hangs off org membership. Making a node privately-owned there
// would mean a second, easy-to-miss authorization path inside a handler that's
// already live in production. A sibling module is safer than a shared one.
type Note struct {
	BaseModel
	OwnerID string `gorm:"type:varchar(36);index;not null" json:"ownerId"`
	// Reserved for a possible future "share with my org", never set today.
	// Mirrors the Collection pattern (OrgID *string, nil = personal) so this
	// column doesn't need a migration if that day comes.
	OrgID *string `gorm:"type:varchar(36);index" json:"orgId,omitempty"`
	// ParentID nil = a root page.
	ParentID *string `gorm:"type:varchar(36);index" json:"parentId,omitempty"`
	// Position among siblings. Rewritten wholesale by MoveTree — see
	// NoteRepository.ReplaceTree — so gaps and non-contiguous values are fine.
	Position int    `gorm:"not null;default:0" json:"position"`
	Title    string `gorm:"type:varchar(300);not null;default:''" json:"title"`
	// Markdown, same format as tasks and docs — one editor and one renderer
	// serve every module.
	Body string `gorm:"type:text" json:"body"`
	// sha256 of Body, recomputed on every body save. A client keeps the value it
	// last read and sends it back as UpdateNoteRequest.BaseHash; a mismatch means
	// another device saved first, which is what makes conflict detection
	// possible without a merge engine.
	BodyHash string `gorm:"type:varchar(64)" json:"bodyHash,omitempty"`
}

// NoteRevision is a snapshot of a note's body taken right before it's
// overwritten. Append-only and never read back by the app today (no history
// UI yet) — it exists purely so that a legitimate, non-conflicting save can
// never be the reason a previous version is unrecoverable.
type NoteRevision struct {
	BaseModel
	NoteID  string `gorm:"type:varchar(36);index;not null" json:"noteId"`
	OwnerID string `gorm:"type:varchar(36);index;not null" json:"-"`
	Title   string `gorm:"type:varchar(300)" json:"title"`
	Body    string `gorm:"type:text" json:"-"`
}

type NoteAttachment struct {
	BaseModel
	NoteID string `gorm:"type:varchar(36);index;not null" json:"noteId"`
	// URL is the proxy path clients fetch — never the bucket, which denies
	// anonymous reads. Path is the bucket object key, never exposed.
	URL         string `gorm:"type:text;not null" json:"url"`
	Path        string `gorm:"type:text"          json:"-"`
	FileName    string `gorm:"type:varchar(255)"  json:"fileName"`
	ContentType string `gorm:"type:varchar(120)"  json:"contentType"`
	Bytes       int64  `json:"bytes"`
	UploadedBy  string `gorm:"type:varchar(36)"   json:"uploadedBy"`
}

func NoteAttachmentRef(noteID, attachmentID string) string {
	return "/api/v1/notes/" + noteID + "/attachments/" + attachmentID + "/raw"
}

func (a *NoteAttachment) NormalizeURL() {
	if a.URL == "" || a.URL[0] != '/' {
		a.URL = NoteAttachmentRef(a.NoteID, a.ID)
	}
}

// ─── Tree ───────────────────────────────────────────────────────────────────

// NoteTreeItem is one row of the navigator: no body, so listing the whole tree
// stays cheap regardless of how much a page contains.
type NoteTreeItem struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId,omitempty"`
	Position int     `json:"position"`
	Title    string  `json:"title"`
	HasBody  bool    `json:"hasBody"`
}

// NoteTreeMove is one page's new placement. The client always sends the whole
// resulting tree; the server just validates and applies it in a transaction —
// no separate move/reorder endpoints, and no place for a partial update to
// leave the tree inconsistent.
type NoteTreeMove struct {
	ID       string  `json:"id"       validate:"required"`
	ParentID *string `json:"parentId"`
	Position int     `json:"position"`
}

// ─── Requests ───────────────────────────────────────────────────────────────

type CreateNoteRequest struct {
	Title    string  `json:"title"    validate:"max=300"`
	ParentID *string `json:"parentId"`
}

// UpdateNoteRequest patches a note; nil fields are left untouched so autosave
// can send just what changed.
type UpdateNoteRequest struct {
	Title *string `json:"title"`
	Body  *string `json:"body"`
	// BaseHash is the BodyHash this device last saw, only meaningful alongside
	// Body. Omitted or empty skips the conflict check (a brand-new note has no
	// prior hash to compare against).
	BaseHash *string `json:"baseHash"`
}

// UpdateNoteResult is what saving a note returns. Conflict is only set when a
// concurrent edit was detected: the note is unchanged and Conflict points at
// the new child page holding the write that was not applied.
type UpdateNoteResult struct {
	Note     *Note             `json:"note"`
	Conflict *NoteConflictInfo `json:"conflict,omitempty"`
}

type NoteConflictInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type NoteSearchResult struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Excerpt string `json:"excerpt"`
}

// NoteExport is every page and every attachment reference the caller owns, in
// one payload. Flat lists rather than a nested tree: the exporter has to walk
// parents anyway to build folders, and one round trip beats one request per
// page for something whose whole purpose is "get all of it out of here".
type NoteExport struct {
	Notes       []Note           `json:"notes"`
	Attachments []NoteAttachment `json:"attachments"`
}
