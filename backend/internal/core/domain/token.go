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
const (
	ScopeTasksWrite  = "tasks:write"
	ScopeTasksManage = "tasks:manage"
)

func ValidScope(s string) bool {
	return s == ScopeTasksWrite || s == ScopeTasksManage
}
