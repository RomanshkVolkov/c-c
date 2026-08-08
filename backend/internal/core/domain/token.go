package domain

import "time"

// PersonalAccessToken is a long-lived, READ-ONLY credential for programmatic
// access (the cac MCP server, scripts, CI). Only its HMAC is stored. The auth
// middleware rejects any non-GET request made with one, so a leaked token can
// never mutate state.
type PersonalAccessToken struct {
	BaseModel
	UserID    string `gorm:"type:varchar(36);index;not null" json:"userId"`
	Name      string `gorm:"type:varchar(120);not null"      json:"name"`
	TokenHash []byte `gorm:"type:bytea;not null;index"       json:"-"`
	// Display hint (e.g. "cac_pat_…a1b2"); the full token is shown once at mint.
	Preview string `gorm:"type:varchar(40)" json:"preview"`
	// Scopes granted beyond reading. Empty — the default, and what every token
	// minted before this existed has — means read-only.
	Scopes     string     `gorm:"type:varchar(200)" json:"scopes"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

type CreateTokenRequest struct {
	Name string `json:"name" validate:"required,min=1,max=120"`
	// Requested scopes; anything unknown is dropped rather than trusted.
	Scopes []string `json:"scopes"`
	// ExpiresInDays: 0 uses the default (90); -1 means "never expires".
	ExpiresInDays int `json:"expiresInDays" validate:"omitempty,min=-1,max=3650"`
}

// UpdateTokenRequest changes what an existing token may do, without minting a
// new one.
//
// Rotating the secret to change a permission was the alternative, and it costs
// more than it looks: the value is shown once, so every place holding it has to
// be found and updated. The predictable outcome is asking for more scopes than
// needed the first time, to avoid ever doing it again — which is the opposite
// of what a scoped token is for.
//
// The secret is untouched: this is authorization, not authentication.
type UpdateTokenRequest struct {
	// Name renames the token. Omitted (nil) leaves it alone.
	Name *string `json:"name" validate:"omitempty,min=1,max=120"`
	// Scopes replaces the set outright — the same all-or-nothing shape as
	// minting, so "what this token may do" is always the whole answer and never
	// a diff someone has to reconstruct. Omitted (nil) leaves them alone; an
	// empty array is meaningful and makes the token read-only.
	Scopes *[]string `json:"scopes"`
}

type TokenResponse struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Preview    string     `json:"preview"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	// Empty means read-only, so the list can say what each token may do.
	Scopes []string `json:"scopes"`
}

// CreateTokenResult carries the plaintext token, returned exactly once.
type CreateTokenResult struct {
	Token TokenResponse `json:"token"`
	Value string        `json:"value"`
}

// ─── Scopes ───────────────────────────────────────────────────────────────────

// Scopes are split by what they can destroy, not by resource.
//
// ScopeTasksWrite only ever *adds*: a new task, a new comment. Nothing it can do
// overwrites something a person wrote, which makes it the safe default for
// automated callers.
//
// ScopeTasksManage changes tasks that already exist — including replacing a
// description someone spent time on. Separate on purpose: an agent that files
// findings shouldn't need the power to erase them.
//
// ScopeNotesWrite/ScopeNotesManage mirror that same split for notes: creating
// a page can't touch one that already exists, so a migration script only
// needs Write. Manage is what update_note needs, since it can overwrite a
// page's body outright.
// ScopeReportsWrite/ScopeReportsManage do the same for reports, and are what
// lets a tenant app drive its own triage with a single token instead of a
// username and password: reading is already allowed for any token, so a
// read-only one covers "my reports" and the board with no scope at all.
const (
	ScopeTasksWrite    = "tasks:write"
	ScopeTasksManage   = "tasks:manage"
	ScopeNotesWrite    = "notes:write"
	ScopeNotesManage   = "notes:manage"
	ScopeReportsWrite  = "reports:write"
	ScopeReportsManage = "reports:manage"
	// No matching Manage: a token may create a collection and nothing else.
	// Editing, deleting and sharing one all reach work a person already owns,
	// and sharing reaches other people — that stays a human decision.
	ScopeCollectionsWrite = "collections:write"
)

func ValidScope(s string) bool {
	switch s {
	case ScopeTasksWrite, ScopeTasksManage,
		ScopeNotesWrite, ScopeNotesManage,
		ScopeReportsWrite, ScopeReportsManage,
		ScopeCollectionsWrite:
		return true
	default:
		return false
	}
}
