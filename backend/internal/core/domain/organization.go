package domain

import "time"

// OrgRole is a user's role within an organization. Roles are per-membership so
// a user can be admin of one org and viewer of another.
type OrgRole string

const (
	OrgRoleAdmin  OrgRole = "admin"
	OrgRoleMember OrgRole = "member"
	OrgRoleViewer OrgRole = "viewer"
)

// IsValid reports whether r is one of the known roles.
func (r OrgRole) IsValid() bool {
	switch r {
	case OrgRoleAdmin, OrgRoleMember, OrgRoleViewer:
		return true
	}
	return false
}

// CanWrite reports whether the role may create/update resources (not delete).
func (r OrgRole) CanWrite() bool {
	return r == OrgRoleAdmin || r == OrgRoleMember
}

// ─── Models ───────────────────────────────────────────────────────────────────

// Organization separates resources (servers, collections, reports) by company.
type Organization struct {
	BaseModel
	Name string `gorm:"type:varchar(100);not null"           json:"name"`
	Slug string `gorm:"type:varchar(100);uniqueIndex;not null" json:"slug"`
}

// OrgMembership joins a user to an organization with a role. Composite PK
// (org_id, user_id) enforces one membership per pair.
type OrgMembership struct {
	OrgID     string    `gorm:"type:varchar(36);primaryKey" json:"orgId"`
	UserID    string    `gorm:"type:varchar(36);primaryKey" json:"userId"`
	Role      OrgRole   `gorm:"type:varchar(20);not null"   json:"role"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ─── JWT claim ────────────────────────────────────────────────────────────────

// OrgMembershipClaim is the compact membership embedded in the access token so
// scoping middleware can decide access without a DB round-trip.
type OrgMembershipClaim struct {
	OrgID string  `json:"orgId"`
	Role  OrgRole `json:"role"`
}

// ─── Requests / Responses ─────────────────────────────────────────────────────

type CreateOrganizationRequest struct {
	Name string `json:"name" validate:"required,min=1,max=100"`
	Slug string `json:"slug" validate:"omitempty,min=1,max=100"`
}

type UpdateOrganizationRequest struct {
	Name string `json:"name" validate:"required,min=1,max=100"`
}

type OrganizationResponse struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Slug string  `json:"slug"`
	Role OrgRole `json:"role"` // caller's role in this org
}

type AddMemberRequest struct {
	UserID string  `json:"userId" validate:"required"`
	Role   OrgRole `json:"role"   validate:"required,oneof=admin member viewer"`
}

type UpdateMemberRequest struct {
	Role OrgRole `json:"role" validate:"required,oneof=admin member viewer"`
}

type MemberResponse struct {
	UserID   string  `json:"userId"`
	Username string  `json:"username"`
	Role     OrgRole `json:"role"`
}
