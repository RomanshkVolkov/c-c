package domain

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ─── Models ──────────────────────────────────────────────────────────────────

type User struct {
	BaseModel
	Username string `gorm:"uniqueIndex;type:varchar(100);not null" json:"username"`
	Password string `gorm:"type:varchar(255);not null" json:"-"`
	Email    string `gorm:"type:varchar(255)"              json:"email"`
	// LastSeenAt is when this account last did anything. Written at most once
	// every few minutes rather than on every request — the question it answers
	// is "is this person around", and that does not need second precision at
	// the cost of a write per call.
	LastSeenAt *time.Time `gorm:"index" json:"lastSeenAt,omitempty"`
	Name       string     `gorm:"type:varchar(120)"              json:"name"`
	// IsSuperadmin: platform-level admin that sees/manages ALL organizations
	// (bypasses per-org membership scoping).
	IsSuperadmin bool `gorm:"default:false" json:"isSuperadmin"`
	// MustChangePassword forces a password change on next login — set when a
	// superadmin provisions or resets the password (so admins don't retain
	// knowledge of a working password), cleared when the user sets their own.
	MustChangePassword bool `gorm:"default:false" json:"mustChangePassword"`
	// Locale is which language this person reads cac in: "en", "es", or empty
	// for "whatever their machine says".
	//
	// It lives on the server and not only in the client for a reason that is
	// not the obvious one. Following you between machines is the small half.
	// The big half is that **the server writes rows for you**: an inbox
	// notification is one row per recipient, written once and read months
	// later, so without knowing who is going to read it the phrase is frozen
	// in the language of whoever caused it.
	//
	// Empty rather than a default of "en": there is a real difference between
	// "I chose English" and "I never chose", and only the second one should
	// follow the operating system.
	Locale string `gorm:"type:varchar(5)" json:"locale,omitempty"`
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

type ClaimsJWT struct {
	UserID     string               `json:"user_id"`
	Username   string               `json:"username"`
	Superadmin bool                 `json:"superadmin"`
	Orgs       []OrgMembershipClaim `json:"orgs"`
	// Scopes is set only for personal access tokens; a signed-in user's JWT
	// carries none and is limited by their org role instead.
	Scopes []string `json:"scopes,omitempty"`
	// ProjectID marks a caller that authenticated with a project's ingest key
	// rather than as a person. It is never present in a signed token — the
	// middleware sets it — and when it is set the caller may only touch that
	// one project. A tenant driving its own board is not a user, and inventing
	// a fake one to represent it costs a password to store and gives it every
	// project its organization owns.
	ProjectID string `json:"-"`
	// ProjectOrgID is that project's organization. Carried so the list query can
	// still be scoped by org without granting membership in it — putting the org
	// in Orgs instead would let RoleInOrg succeed for every *other* project the
	// organization owns, which is the exact privilege this credential exists to
	// avoid.
	ProjectOrgID string `json:"-"`
	// ProjectName is what a reply from this caller is signed with in the cac
	// thread. A comment has to say who wrote it, and "the key" is not an answer.
	ProjectName string `json:"-"`
	// ProjectSlug identifies the tenant in emitted events. Stored rather than
	// derived from Username, which only happens to be formatted that way.
	ProjectSlug string `json:"-"`
	jwt.RegisteredClaims
}

// IsProjectScoped reports whether this caller is a project key. Authorization
// for these callers is "does it belong to my project", not org membership —
// see the two gates in report_admin.go.
func (c *ClaimsJWT) IsProjectScoped() bool { return c.ProjectID != "" }

// EventActor names who caused an event, so a tenant receiving the webhook can
// ignore what it did itself. Without it, portento changing a status gets a
// webhook back about its own change and cannot tell it apart from ours.
func (c *ClaimsJWT) EventActor() string {
	if c.IsProjectScoped() {
		return "project:" + c.ProjectSlug
	}
	return "team"
}

// HasScope reports whether a token was granted a capability. Always false for a
// JWT, which doesn't use scopes.
func (c *ClaimsJWT) HasScope(scope string) bool {
	for _, s := range c.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// OrgIDs returns the ids of every org the caller belongs to.
func (c *ClaimsJWT) OrgIDs() []string {
	ids := make([]string, 0, len(c.Orgs))
	for _, o := range c.Orgs {
		ids = append(ids, o.OrgID)
	}
	return ids
}

// RoleInOrg returns the caller's role in orgID and whether they belong to it.
func (c *ClaimsJWT) RoleInOrg(orgID string) (OrgRole, bool) {
	for _, o := range c.Orgs {
		if o.OrgID == orgID {
			return o.Role, true
		}
	}
	return "", false
}

type ClaimsRefresh struct {
	TokenID string `json:"token_id"`
	UserID  string `json:"user_id"`
	jwt.RegisteredClaims
}

type TokenPair struct {
	AccessToken  string
	RefreshToken string
}

// ─── Requests / Responses ────────────────────────────────────────────────────

type LoginRequest struct {
	Username string `json:"username" validate:"required"`
	Password string `json:"password" validate:"required,min=8"`
}

type AuthResponse struct {
	AccessToken  string  `json:"accessToken"`
	RefreshToken string  `json:"refreshToken"`
	ExpiresIn    int64   `json:"expiresIn"`
	Session      Session `json:"session"`
}

type Session struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	// Email is shown in the account menu, where the username alone is not
	// enough to tell two accounts apart on a shared machine.
	Email              string `json:"email,omitempty"`
	Superadmin         bool   `json:"superadmin"`
	MustChangePassword bool   `json:"mustChangePassword"`
	// Scopes of the token that made this call — empty for a signed-in user's JWT.
	// Exposed so an automated caller can check what it may do *before* trying it,
	// which is what makes a dry run possible without writing anything.
	Scopes []string `json:"scopes,omitempty"`
	// Locale as stored on the server; empty means "ask the machine".
	Locale string `json:"locale,omitempty"`
}

// SetLocaleRequest is the whole of the language endpoint: one field.
//
// A locale of "" is a valid value and not a missing one — it is how you say
// "go back to following my system". That is why there is no `required` here.
type SetLocaleRequest struct {
	Locale string `json:"locale"`
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"currentPassword" validate:"required"`
	NewPassword     string `json:"newPassword"     validate:"required,min=8"`
}

type AuthRefreshResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

// ─── User management (superadmin) ─────────────────────────────────────────────

type CreateUserRequest struct {
	Username     string `json:"username"     validate:"required,min=3,max=100"`
	Password     string `json:"password"     validate:"required,min=8"`
	Email        string `json:"email"        validate:"omitempty,email,max=255"`
	Name         string `json:"name"         validate:"omitempty,max=120"`
	IsSuperadmin bool   `json:"isSuperadmin"`
}

// UpdateUserRequest patches a user. Nil fields are left unchanged; an empty
// password string means "don't rotate".
type UpdateUserRequest struct {
	Password     string  `json:"password"     validate:"omitempty,min=8"`
	Email        *string `json:"email"       validate:"omitempty,email,max=255"`
	Name         *string `json:"name"        validate:"omitempty,max=120"`
	IsSuperadmin *bool   `json:"isSuperadmin"`
}

type UserResponse struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	IsSuperadmin bool      `json:"isSuperadmin"`
	CreatedAt    time.Time `json:"createdAt"`
}
