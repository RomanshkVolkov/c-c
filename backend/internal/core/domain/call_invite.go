package domain

import (
	"strings"
	"time"
)

// Llamar con gente de fuera: una invitación, su sala y quién entró con ella.
//
// La decisión que gobierna este fichero: **cada invitación tiene su propia
// sala**, `meet:<id>`, y nunca es la sala de un canal (`voice:<spaceId>`). Un
// enlace que se reenvía, se pega en un correo y acaba en manos de quien no
// debía no puede abrir la voz permanente de un equipo: abre una reunión que
// caduca, que se puede revocar y de la que se puede echar a alguien. El canal
// sigue siendo de los miembros.
//
// Y una identidad de invitado es **siempre** `guest:<id>`, acuñada por el
// servidor. Todo lo que en cac lee una identidad de LiveKit —quién está, quién
// habla, de quién es una pista— la ha leído hasta hoy como un id de usuario;
// el prefijo es lo que deja distinguir sin preguntarle a nadie, y que lo acuñe
// el servidor es lo que impide que un invitado se presente como un miembro.

// CallInvite es una reunión a la que se puede entrar con un enlace.
type CallInvite struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// SpaceID es el canal del que cuelga, si cuelga de alguno. Es donde viven
	// el chat de los miembros, las grabaciones y el anuncio de que hay una: sin
	// canal, la reunión se puede hacer pero no grabar.
	SpaceID   *string `gorm:"type:varchar(36);index" json:"spaceId,omitempty"`
	Title     string  `gorm:"type:varchar(120);not null" json:"title"`
	CreatedBy string  `gorm:"type:varchar(36);not null" json:"createdBy"`

	// La vida del enlace vive aquí y no dentro del token: así revocar es una
	// escritura y no una lista negra, y el enlace se puede volver a enseñar
	// cuantas veces haga falta sin guardar ningún secreto.
	ExpiresAt time.Time  `gorm:"index;not null" json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`

	// MaxGuests: cuántas personas de fuera pueden entrar con este enlace. Cero
	// es sin tope. Se cuenta sobre las filas de `CallGuest`, no sobre quién está
	// dentro ahora: un enlace para dos que se reenvía a veinte no tiene que
	// dejar entrar a veinte por turnos.
	MaxGuests int `json:"maxGuests"`
}

func (CallInvite) TableName() string { return "call_invites" }

// Room es la sala de la invitación. Derivada del id **en el servidor**, igual
// que la de un canal: nunca se acepta del cliente.
func (i CallInvite) Room() string { return MeetRoomFor(i.ID) }

// Live: si el enlace todavía abre algo.
func (i CallInvite) Live(now time.Time) bool {
	return i.RevokedAt == nil && now.Before(i.ExpiresAt)
}

// CallGuest es una persona de fuera que entró con un enlace.
//
// Existe para poder echarla **y que no vuelva con el mismo pase**: sacarla de
// la sala sólo la desconecta, y su página volvería a pedir entrada al momento.
// La fila es lo que el servidor mira al acuñarle otra entrada.
type CallGuest struct {
	BaseModel
	InviteID string `gorm:"type:varchar(36);index;not null" json:"inviteId"`
	// Name es el que escribió al entrar. No es de nadie ni es único: sólo sirve
	// para pintarlo.
	Name       string     `gorm:"type:varchar(60);not null" json:"name"`
	KickedAt   *time.Time `json:"kickedAt,omitempty"`
	KickedBy   string     `gorm:"type:varchar(36)" json:"kickedBy,omitempty"`
	LastJoinAt time.Time  `json:"lastJoinAt"`
}

func (CallGuest) TableName() string { return "call_guests" }

// Los prefijos de sala y de identidad.
const (
	MeetRoomPrefix      = "meet:"
	GuestIdentityPrefix = "guest:"
)

// MeetRoomFor es la sala de una invitación. Otro prefijo que el de los canales
// a propósito: es lo que hace imposible que una invitación abra un canal por
// mucho que coincidan los ids.
func MeetRoomFor(inviteID string) string { return MeetRoomPrefix + inviteID }

// GuestIdentity es la identidad de LiveKit de un invitado.
func GuestIdentity(guestID string) string { return GuestIdentityPrefix + guestID }

// IsGuestIdentity dice si una identidad es de alguien de fuera.
//
// Por el prefijo y **desde el principio**: un id de usuario es un uuid y nunca
// empieza así, y mirar si «contiene» el prefijo dejaría que un nombre lo
// fingiera.
func IsGuestIdentity(identity string) bool {
	return strings.HasPrefix(identity, GuestIdentityPrefix)
}

// GuestIDOf: el id de la fila de un invitado a partir de su identidad.
func GuestIDOf(identity string) (string, bool) {
	if !IsGuestIdentity(identity) {
		return "", false
	}
	return strings.TrimPrefix(identity, GuestIdentityPrefix), true
}

// Cuánto vive una invitación: lo que se pide, entre una hora y una semana.
const (
	CallInviteTTLDefault = 24 * time.Hour
	CallInviteTTLMin     = time.Hour
	CallInviteTTLMax     = 7 * 24 * time.Hour
)

// GuestNameMax: lo más largo que puede ser el nombre de un invitado.
const GuestNameMax = 60

// ─── Peticiones y respuestas ─────────────────────────────────────────────────

type CreateCallInviteRequest struct {
	OrgID   string `json:"orgId"   validate:"required"`
	SpaceID string `json:"spaceId"`
	Title   string `json:"title"   validate:"required,max=120"`
	// TTLHours: cuántas horas vale el enlace. Cero es el valor por defecto.
	TTLHours  int `json:"ttlHours"  validate:"omitempty,min=1,max=168"`
	MaxGuests int `json:"maxGuests" validate:"omitempty,min=0,max=100"`
}

// CallInviteResponse es la invitación para un miembro: con su enlace y con
// quién está dentro.
type CallInviteResponse struct {
	CallInvite
	// Link es el token que va en el enlace. Sólo lo ve un miembro.
	Link          string             `json:"link"`
	CreatedByName string             `json:"createdByName,omitempty"`
	SpaceName     string             `json:"spaceName,omitempty"`
	Occupants     []OccupantResponse `json:"occupants"`
}

// OccupantResponse: alguien que está dentro de una sala.
type OccupantResponse struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
}

// PublicCallInvite es lo que ve alguien de fuera antes de entrar.
//
// **Sin un solo id.** Ni de la organización, ni del canal, ni de quien invita:
// la página del invitado no los necesita para nada, y un enlace reenviado no
// tiene por qué contarle a nadie cómo está montado cac por dentro.
type PublicCallInvite struct {
	Title     string    `json:"title"`
	OrgName   string    `json:"orgName"`
	HostName  string    `json:"hostName"`
	ExpiresAt time.Time `json:"expiresAt"`
	// RecordingActive: se está grabando ahora mismo. La página lo dice antes de
	// que nadie pulse «entrar».
	RecordingActive bool `json:"recordingActive"`
	// RecordingPossible: se puede grabar aunque ahora no se esté haciendo.
	RecordingPossible bool `json:"recordingPossible"`
}

type PublicCallRequest struct {
	Token string `json:"token" validate:"required"`
}

type GuestJoinRequest struct {
	Token string `json:"token" validate:"required"`
	Name  string `json:"name"`
	// Pass es el pase de quien ya entró antes. Con él se vuelve con la misma
	// identidad; sin él se entra como alguien nuevo.
	Pass string `json:"pass"`
}

// GuestJoinResponse: todo lo que la página del invitado necesita para entrar.
type GuestJoinResponse struct {
	URL      string `json:"url"`
	Token    string `json:"token"`
	Room     string `json:"room"`
	Identity string `json:"identity"`
	Name     string `json:"name"`
	Pass     string `json:"pass"`
	Title    string `json:"title"`
}

// MeetTokenResponse: la entrada de un miembro a una reunión.
type MeetTokenResponse struct {
	URL      string  `json:"url"`
	Token    string  `json:"token"`
	Room     string  `json:"room"`
	OrgID    string  `json:"orgId"`
	SpaceID  *string `json:"spaceId,omitempty"`
	InviteID string  `json:"inviteId"`
	Title    string  `json:"title"`
}
