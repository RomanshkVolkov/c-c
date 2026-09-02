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
	// Domain is what this organization's people use for email. Informational:
	// nothing is enforced against it, and saying so here keeps somebody from
	// later assuming it gates anything.
	Domain string `gorm:"type:varchar(255)" json:"domain"`

	// ── Rules ────────────────────────────────────────────────────────────────
	//
	// No `default:` tags on the booleans, on purpose. GORM omits Go zero values
	// from an INSERT, so a column defaulting to true makes "turn this off"
	// store itself as on — a setting that silently does nothing. The defaults
	// are written explicitly when the organization is created.

	// DefaultInviteRole is what the invite form starts on.
	DefaultInviteRole OrgRole `gorm:"type:varchar(20)" json:"defaultInviteRole"`
	// ClientsSeeOnlyTheirSpace keeps a tenant's reach to the space bound to
	// their channel, which is the assumption every screen already makes.
	ClientsSeeOnlyTheirSpace bool `json:"clientsSeeOnlyTheirSpace"`
	// GuestsCanUseDevTools is how somebody without an account reaches the
	// on-device tools and nothing else.
	GuestsCanUseDevTools bool `json:"guestsCanUseDevTools"`
}

// OrgMembership joins a user to an organization with a role. Composite PK
// (org_id, user_id) enforces one membership per pair.
type OrgMembership struct {
	OrgID     string    `gorm:"type:varchar(36);primaryKey" json:"orgId"`
	UserID    string    `gorm:"type:varchar(36);primaryKey" json:"userId"`
	Role      OrgRole   `gorm:"type:varchar(20);not null"   json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}

// InvitationStatus is the lifecycle of an org invitation.
type InvitationStatus string

const (
	InvitePending  InvitationStatus = "pending"
	InviteAccepted InvitationStatus = "accepted"
	InviteDeclined InvitationStatus = "declined"
	InviteRevoked  InvitationStatus = "revoked"
)

// OrgInvitation lets an org admin invite an existing user (by user id) into
// their org. The invitee accepts in-app (no email/link): acceptance creates the
// membership. One pending invitation per (org, user) is enforced by the service.
type OrgInvitation struct {
	BaseModel
	OrgID           string           `gorm:"type:varchar(36);index;not null" json:"orgId"`
	InvitedUserID   string           `gorm:"type:varchar(36);index;not null" json:"invitedUserId"`
	Role            OrgRole          `gorm:"type:varchar(20);not null"       json:"role"`
	InvitedByUserID string           `gorm:"type:varchar(36);not null"       json:"invitedByUserId"`
	Status          InvitationStatus `gorm:"type:varchar(20);not null;default:pending;index" json:"status"`
	ExpiresAt       time.Time        `gorm:"index" json:"expiresAt"`
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
	// The rules. Pointers so "not mentioned" and "set to false" are different
	// requests: a form that saves one toggle must not silently turn the others
	// off just by not talking about them.
	Domain                   *string  `json:"domain"`
	DefaultInviteRole        *OrgRole `json:"defaultInviteRole" validate:"omitempty,oneof=admin member viewer"`
	ClientsSeeOnlyTheirSpace *bool    `json:"clientsSeeOnlyTheirSpace"`
	GuestsCanUseDevTools     *bool    `json:"guestsCanUseDevTools"`
}

type OrganizationResponse struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Slug string  `json:"slug"`
	Role OrgRole `json:"role"` // caller's role in this org
	// MemberCount is how many people are in it. Counted in the same query that
	// lists the organizations rather than left to the client, which would
	// otherwise have to pull the whole member list of every organization just
	// to show a number beside its name.
	MemberCount int64 `json:"memberCount"`
	// CreatedAt is shown on the organization screen: a place with a date on it
	// is easier to tell apart from one somebody made by accident last week.
	CreatedAt time.Time `json:"createdAt"`
	Domain    string    `json:"domain,omitempty"`

	// The rules, so the General tab can show them without a second request.
	DefaultInviteRole        OrgRole `json:"defaultInviteRole,omitempty"`
	ClientsSeeOnlyTheirSpace bool    `json:"clientsSeeOnlyTheirSpace"`
	GuestsCanUseDevTools     bool    `json:"guestsCanUseDevTools"`
}

type AddMemberRequest struct {
	UserID string  `json:"userId" validate:"required"`
	Role   OrgRole `json:"role"   validate:"required,oneof=admin member viewer"`
}

type UpdateMemberRequest struct {
	Role OrgRole `json:"role" validate:"required,oneof=admin member viewer"`
}

type MemberResponse struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	// Name es el nombre con el que se le llama a alguien, y va **junto al**
	// usuario, no en su lugar.
	//
	// El usuario es el identificador: es lo que se escribe tras una arroba, lo
	// que se busca en el selector, y lo que no cambia. El nombre es cómo se lee.
	// Enseñar «rvolkov» donde cabe «Romanshk Volkov» hace que una lista de gente
	// se lea como una tabla de la base de datos.
	//
	// Puede venir vacío —nadie está obligado a ponerlo— y quien lo pinte tiene
	// que caer al usuario. Ver `nombreDe` en el cliente.
	Name  string  `json:"name,omitempty"`
	Email string  `json:"email,omitempty"`
	Role  OrgRole `json:"role"`
	// LastSeenAt is what the members table shows as activity. Absent means the
	// account has not been used since this started being recorded, which the
	// screen says as "never" rather than inventing a date.
	LastSeenAt *time.Time `json:"lastSeenAt,omitempty"`
}

type CreateInvitationRequest struct {
	UserID string  `json:"userId" validate:"required"`
	Role   OrgRole `json:"role"   validate:"required,oneof=admin member viewer"`
}

// InvitationResponse is the invitee-facing view (org name + inviter username so
// they know what they're accepting).
type InvitationResponse struct {
	ID          string           `json:"id"`
	OrgID       string           `json:"orgId"`
	OrgName     string           `json:"orgName"`
	Role        OrgRole          `json:"role"`
	Status      InvitationStatus `json:"status"`
	InvitedBy   string           `json:"invitedBy"`   // inviter username
	InvitedUser string           `json:"invitedUser"` // invitee username (org-side listing)
	CreatedAt   time.Time        `json:"createdAt"`
	// ExpiresAt viaja porque la vista de administración muestra las caducadas
	// para poder reenviarlas; sin la fecha no hay forma de distinguirlas.
	ExpiresAt time.Time `json:"expiresAt"`
}
