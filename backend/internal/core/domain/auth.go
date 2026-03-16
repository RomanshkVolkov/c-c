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
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
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
