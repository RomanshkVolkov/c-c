package domain

import "time"

// ServerIntegration is a tool exposed through a platform-hub (kubernetes) server:
// Grafana, pgAdmin, a dashboard, or any web endpoint. cac stores its URL and
// (optionally) credentials — encrypted at rest — and offers an authenticated
// launcher: open the URL + reveal/copy creds on demand, gated by org role.
type ServerIntegration struct {
	BaseModel
	ServerID string `gorm:"type:varchar(36);index;not null" json:"serverId"`
	OrgID    string `gorm:"type:varchar(36);index;not null" json:"orgId"` // denormalized for scoping
	Kind     string `gorm:"type:varchar(40);not null"       json:"kind"`  // grafana|pgadmin|generic|...
	Name     string `gorm:"type:varchar(120);not null"      json:"name"`
	URL      string `gorm:"type:text;not null"              json:"url"`
	// AuthMethod is forward-looking (F3 proxy/SSO). F2 only launches + vaults.
	AuthMethod string `gorm:"type:varchar(20);default:'none'" json:"authMethod"` // none|basic|bearer|header
	// Secret: AES-GCM blob (e.g. {"username":..,"password":..} or a token).
	// Never serialized — surfaced only via the explicit reveal endpoint.
	Secret []byte `gorm:"type:bytea"           json:"-"`
	Hidden bool   `gorm:"default:false"        json:"hidden"`
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

type CreateIntegrationRequest struct {
	Kind       string `json:"kind"       validate:"required,max=40"`
	Name       string `json:"name"       validate:"required,min=1,max=120"`
	URL        string `json:"url"        validate:"required,url"`
	AuthMethod string `json:"authMethod" validate:"omitempty,oneof=none basic bearer header"`
	Secret     string `json:"secret"     validate:"omitempty"` // plaintext creds; encrypted server-side
}

type UpdateIntegrationRequest struct {
	Name       string `json:"name"       validate:"required,min=1,max=120"`
	URL        string `json:"url"        validate:"required,url"`
	AuthMethod string `json:"authMethod" validate:"omitempty,oneof=none basic bearer header"`
	Hidden     *bool  `json:"hidden"`
	// Secret: nil = leave unchanged; "" = clear; non-empty = replace (re-encrypted).
	Secret *string `json:"secret" validate:"omitempty"`
}

// IntegrationResponse never carries the secret — only whether one is set.
type IntegrationResponse struct {
	ID         string    `json:"id"`
	ServerID   string    `json:"serverId"`
	Kind       string    `json:"kind"`
	Name       string    `json:"name"`
	URL        string    `json:"url"`
	AuthMethod string    `json:"authMethod"`
	HasSecret  bool      `json:"hasSecret"`
	Hidden     bool      `json:"hidden"`
	CreatedAt  time.Time `json:"createdAt"`
}

// RevealResponse is the decrypted secret, returned only from the explicit,
// role-gated reveal endpoint.
type RevealResponse struct {
	Secret string `json:"secret"`
}
