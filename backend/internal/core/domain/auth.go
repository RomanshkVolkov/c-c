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
	Name     string `gorm:"type:varchar(120)"              json:"name"`
	// IsSuperadmin: platform-level admin that sees/manages ALL organizations
	// (bypasses per-org membership scoping).
	IsSuperadmin bool `gorm:"default:false" json:"isSuperadmin"`
	// MustChangePassword forces a password change on next login — set when a
	// superadmin provisions or resets the password (so admins don't retain
	// knowledge of a working password), cleared when the user sets their own.
	MustChangePassword bool `gorm:"default:false" json:"mustChangePassword"`
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

type ClaimsJWT struct {
	UserID     string               `json:"user_id"`
	Username   string               `json:"username"`
	Superadmin bool                 `json:"superadmin"`
	Orgs       []OrgMembershipClaim `json:"orgs"`
	jwt.RegisteredClaims
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
	ID                 string `json:"id"`
	Username           string `json:"username"`
	Superadmin         bool   `json:"superadmin"`
	MustChangePassword bool   `json:"mustChangePassword"`
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
