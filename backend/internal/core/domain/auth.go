package domain

import "github.com/golang-jwt/jwt/v5"

// ─── Models ──────────────────────────────────────────────────────────────────

type User struct {
	BaseModel
	Username string `gorm:"uniqueIndex;type:varchar(100);not null" json:"username"`
	Password string `gorm:"type:varchar(255);not null" json:"-"`
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

type ClaimsJWT struct {
	UserID   string               `json:"user_id"`
	Username string               `json:"username"`
	Orgs     []OrgMembershipClaim `json:"orgs"`
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
	ID       string `json:"id"`
	Username string `json:"username"`
}

type AuthRefreshResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}
