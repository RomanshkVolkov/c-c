package domain

import (
	"strings"
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
	// Web: la sesión empezó en la versión web (cac.guz-studio.dev/app). Va
	// firmado dentro del token y lo arrastra cada refresh, así que no se puede
	// quitar. Con él, lo que es sólo del escritorio —servidores, tokens
	// personales— contesta 403: un token robado de un navegador no abre la
	// infraestructura (barrido de seguridad, 6-oct-2026). Ver DesktopOnlyPath.
	Web bool `json:"web,omitempty"`
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
	// ViaToken dice que quien llama entró con un token personal y no con su
	// sesión: detrás puede haber un agente con el token de su dueño.
	//
	// Igual que ProjectID, nunca viene en un token firmado —`json:"-"`, así que
	// ni un JWT fabricado puede traerlo puesto— y sólo lo pone el middleware,
	// que es el único sitio que sabe cómo llegó la petición. `Scopes` no vale
	// como marca: un token de sólo lectura no tiene ninguno.
	//
	// Existe para lo que una persona tiene que hacer en persona. Hoy, firmar la
	// revisión de un documento (ver DocReviewSigner).
	ViaToken bool `json:"-"`
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
	// Web: ver ClaimsJWT.Web. El refresh lo lleva para que la sesión siga
	// siendo web al renovarse.
	Web bool `json:"web,omitempty"`
	jwt.RegisteredClaims
}

type TokenPair struct {
	AccessToken  string
	RefreshToken string
	// RefreshID y RefreshExpiresAt: lo que hay que apuntar del refresh recién
	// emitido para poder rotarlo y revocarlo. Ver RefreshSession.
	RefreshID        string
	RefreshExpiresAt time.Time
}

// RefreshSession es un refresh token emitido, **con estado**.
//
// Hasta el 5-oct-2026 el refresh era un JWT sin más: valía siete días y no
// había forma de invalidarlo. Con la app de escritorio guardándolo en su
// `localStorage` era tolerable; con una versión web en un origen público
// (cac.guz-studio.dev/app) un refresh robado sería una semana de sesión ajena.
//
// Cada refresh se usa **una vez**: al canjearlo se emite otro de la misma
// familia y éste queda rotado. Si alguien presenta uno ya rotado fuera del
// margen de gracia, alguien tiene una copia, y se revoca la familia entera
// —la sesión legítima incluida—: perder la sesión es mejor que compartirla.
type RefreshSession struct {
	// ID es el `TokenID` del claim, que ya viajaba en cada refresh y nadie miraba.
	ID        string    `gorm:"type:varchar(36);primaryKey"`
	UserID    string    `gorm:"type:varchar(36);index;not null"`
	FamilyID  string    `gorm:"type:varchar(36);index;not null"`
	ExpiresAt time.Time `gorm:"not null;index"`
	// RotatedAt: cuándo se canjeó. Nil = vigente.
	RotatedAt *time.Time
	// RevokedAt: cerrada a propósito (logout, o robo detectado).
	RevokedAt *time.Time
	CreatedAt time.Time
}

// RefreshReuseGrace: cuánto tiempo después de rotar un refresh se acepta otra
// vez sin dar la sesión por robada.
//
// Existe porque dos peticiones que caducan a la vez —dos pestañas, o la app y
// su ventana de llamada— piden refresh casi juntas con el mismo token, y la
// segunda llega cuando la primera ya lo rotó. Sin margen, eso cerraría la
// sesión de quien no ha hecho nada mal. Un minuto cubre esa carrera y no da a
// un ladrón más que un minuto para adelantarse.
const RefreshReuseGrace = time.Minute

// ─── Requests / Responses ────────────────────────────────────────────────────

type LoginRequest struct {
	Username string `json:"username" validate:"required"`
	Password string `json:"password" validate:"required,min=8"`
	// Client: `web` desde la versión web. Vacío o `desktop` es la app de
	// escritorio (y lo que no lo diga, como las apps anteriores).
	Client string `json:"client" validate:"omitempty,oneof=web desktop"`
}

// desktopOnlyPrefixes: lo que una sesión web no puede tocar. Los servidores —su
// agente, sus secrets, sus deploys, sus integraciones— y crear o revocar tokens
// personales, que darían una credencial nueva sin caducidad.
var desktopOnlyPrefixes = []string{"/api/v1/servers", "/api/v1/auth/tokens"}

// DesktopOnlyPath: si una ruta es sólo para la app de escritorio.
func DesktopOnlyPath(path string) bool {
	for _, p := range desktopOnlyPrefixes {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
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
	Name string `json:"name,omitempty"`
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

// URLTicketResponse: un pase de URL (ver repository/url_ticket.go).
type URLTicketResponse struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type AuthRefreshResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

// ─── User management (superadmin) ─────────────────────────────────────────────

// CreateUserRequest da de alta a alguien. Correo y nombre son obligatorios
// **al crear** (decisión del 28-sep-2026): una cuenta nueva sin nombre se pinta
// como su usuario en todas partes, y sin correo no hay a quién escribirle.
// Editar no lo exige —vaciar el correo sigue siendo «bórralo», ver
// `UpdateUserRequest`—, así que las cuentas viejas sin correo siguen editándose.
// El nombre lleva `notblank` en vez de `required`: un nombre de espacios pasa
// `required`, y `notblank` rechaza también el vacío.
type CreateUserRequest struct {
	Username     string `json:"username"     validate:"required,min=3,max=100"`
	Password     string `json:"password"     validate:"required,min=8"`
	Email        string `json:"email"        validate:"required,email,max=255"`
	Name         string `json:"name"         validate:"notblank,max=120"`
	IsSuperadmin bool   `json:"isSuperadmin"`
}

// UpdateUserRequest patches a user. Nil fields are left unchanged; an empty
// password string means "don't rotate".
// UpdateProfileRequest es lo que alguien puede cambiar **de sí mismo**.
//
// Tipo aparte de `UpdateUserRequest` a propósito, y no una comprobación dentro
// del handler: aquél lleva `Password` e `IsSuperadmin`, y reutilizarlo dejaría
// a un endpoint sin privilegios recibiendo campos que no debe aceptar. Que no
// existan en la estructura es una garantía; que un `if` los ignore es una
// costumbre que alguien romperá al añadir el campo siguiente.
//
// La contraseña tiene su propio camino —`/auth/change-password`, que pide la
// actual— y el rol sólo lo cambia un superadmin.
type UpdateProfileRequest struct {
	Name *string `json:"name"  validate:"omitempty,max=120"`
	// Vacío es «bórralo», igual que en el de administración. Ver `nuevoValidador`.
	Email *string `json:"email" validate:"omitempty,emailorblank,max=255"`
}

type UpdateUserRequest struct {
	Password string `json:"password"     validate:"omitempty,min=8"`
	// Vacío no es «no lo mandes»: es «bórralo». Ver `nuevoValidador`.
	Email        *string `json:"email"       validate:"omitempty,emailorblank,max=255"`
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
