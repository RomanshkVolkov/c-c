package domain

import "time"

// Dar de alta a alguien por correo, y restablecer una contraseña.
//
// Un admin de una organización crea la cuenta con el nombre y el correo de la
// persona; a ella le llega un enlace y en la web elige su usuario y su
// contraseña. El admin nunca sabe una contraseña que funcione, que era lo que
// dejaba la alta de antes (la contraseña provisional del superadmin).
//
// El mismo enlace de un solo uso sirve para «olvidé mi contraseña».

const (
	LinkWelcome = "welcome"
	LinkReset   = "reset"
)

// AccountLink es un enlace de un solo uso que llegó por correo.
//
// Sólo se guarda el hash del token (`repository.HashAccountLink`): quien lea la
// base no puede usar un enlace vivo. Pedir uno nuevo da por usados los
// anteriores del mismo propósito, así que el último correo es el único que
// vale.
type AccountLink struct {
	BaseModel
	UserID    string `gorm:"type:varchar(36);index;not null" json:"userId"`
	Purpose   string `gorm:"type:varchar(20);not null"       json:"purpose"`
	TokenHash []byte `gorm:"type:bytea;uniqueIndex;not null" json:"-"`
	// OrgID: la organización que dio de alta (bienvenida). Vacío al restablecer.
	OrgID           string     `gorm:"type:varchar(36)" json:"orgId"`
	CreatedByUserID string     `gorm:"type:varchar(36)" json:"createdByUserId"`
	ExpiresAt       time.Time  `gorm:"index;not null"   json:"expiresAt"`
	UsedAt          *time.Time `json:"usedAt,omitempty"`
}

// CreateAccountRequest: lo que pone el admin. El usuario lo elige la persona.
type CreateAccountRequest struct {
	Name  string  `json:"name"  validate:"notblank,max=120"`
	Email string  `json:"email" validate:"required,email,max=255"`
	Role  OrgRole `json:"role"  validate:"required,oneof=admin member viewer"`
}

const (
	// AccountCreated: no había cuenta con ese correo y se creó.
	AccountCreated = "created"
	// AccountInvited: ya la había; se le invitó a la organización.
	AccountInvited = "invited"
)

type CreateAccountResponse struct {
	Status string `json:"status"`
	UserID string `json:"userId"`
	// EmailSent: si el correo salió. Si no (sin correo configurado, o SES lo
	// rechazó), Link trae el enlace para que el admin se lo pase a mano.
	EmailSent bool   `json:"emailSent"`
	Link      string `json:"link,omitempty"`
}

// AccountLinkRequest: el token del enlace, que la web lee de su `#`.
type AccountLinkRequest struct {
	Token string `json:"token" validate:"required,max=200"`
}

// AccountLinkInfo: lo que la página enseña antes de pedir nada.
type AccountLinkInfo struct {
	Purpose string `json:"purpose"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	OrgName string `json:"orgName,omitempty"`
}

type CompleteWelcomeRequest struct {
	Token    string `json:"token"    validate:"required,max=200"`
	Username string `json:"username" validate:"required,min=3,max=40"`
	Password string `json:"password" validate:"required,min=8,max=200"`
	Client   string `json:"client"   validate:"omitempty,oneof=web desktop"`
}

// ForgotPasswordRequest: el usuario o el correo, lo que la persona recuerde.
type ForgotPasswordRequest struct {
	Login string `json:"login" validate:"required,max=255"`
}

type ResetPasswordRequest struct {
	Token    string `json:"token"    validate:"required,max=200"`
	Password string `json:"password" validate:"required,min=8,max=200"`
	Client   string `json:"client"   validate:"omitempty,oneof=web desktop"`
}

// Email es un correo listo para salir.
type Email struct {
	To      string
	Subject string
	Text    string
	HTML    string
}
