package domain

import "time"

// Reuniones periódicas: el aviso que suena a la hora, todos los martes.
//
// La decisión que gobierna este fichero: **la recurrencia no se guarda en UTC**.
// Se guarda la hora de pared —«09:00»—, la zona en la que esa hora significa
// algo —«America/Mexico_City»— y la regla de repetición. Cada ocurrencia se
// convierte a UTC al calcular cuándo toca, no al guardarla.
//
// Comprimirla a UTC es el error clásico de calendario y parece inofensivo:
// «las 9:00 de CDMX son las 15:00Z, guardo eso». Pero «todos los lunes a las 9»
// no es un instante fijo, es una hora de pared; el día que cualquier zona
// implicada cambie al horario de verano, la reunión se le mueve una hora a
// alguien sin que nadie la haya tocado, y nadie relaciona las dos cosas.
type MeetingReminder struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	Title string `gorm:"type:varchar(200);not null"      json:"title"`

	// WallTime en "15:04" y Timezone IANA. Juntos y no un timestamp: ver arriba.
	WallTime string `gorm:"type:varchar(5);not null"  json:"wallTime"`
	Timezone string `gorm:"type:varchar(64);not null" json:"timezone"`

	// La regla, con los campos justos en vez de una RRULE.
	//
	// Una RRULE completa cubre «el tercer jueves salvo festivos» y traería un
	// parser entero para expresar lo que aquí se pide: diaria, semanal en unos
	// días, quincenal y mensual. Cuando haga falta más, se añade — el formato de
	// estos campos no impide crecer.
	Freq     string `gorm:"type:varchar(10);not null" json:"freq"` // daily|weekly|monthly
	Interval int    `gorm:"not null"                  json:"interval"`
	// Weekdays son números de time.Weekday separados por coma: "1,3,5" = lunes,
	// miércoles y viernes. Sólo se mira con freq semanal.
	Weekdays string `gorm:"type:varchar(30)" json:"weekdays"`
	// MonthDay 1..31, sólo con freq mensual. Un 31 se recorta al último día del
	// mes que no lo tenga: pedir «el 31» en febrero es pedir el último día.
	MonthDay int `json:"monthDay"`
	// Anchor ancla el ciclo cuando Interval > 1, en fecha local ("2006-01-02"):
	// sin él, «cada dos semanas» no sabe cuál de las dos es la que toca.
	Anchor string `gorm:"type:varchar(10)" json:"anchor"`

	// SpaceID es la sala a la que lleva el aviso. Opcional: hay reuniones que
	// pasan en otro sitio y el recordatorio sigue valiendo.
	SpaceID   *string `gorm:"type:varchar(36);index" json:"spaceId,omitempty"`
	CreatedBy string  `gorm:"type:varchar(36);not null" json:"createdBy"`

	// NextFireAt es la próxima ocurrencia ya en UTC. Es una optimización —se
	// recalcula siempre desde la regla— pero también **el testigo del reparto**:
	// el disparador se lo juega en un UPDATE condicional sobre este valor, así
	// que quien lo cambie por otra vía tiene que recalcularlo.
	NextFireAt  time.Time  `gorm:"index" json:"nextFireAt"`
	LastFiredAt *time.Time `json:"lastFiredAt,omitempty"`

	// Paused invertido a propósito. El cero del tipo significa «activa», que es
	// lo que debe significar una reunión recién creada; con `Active bool` haría
	// falta un `default:true` que GORM ignora al insertar el zero-value, y la
	// reunión nacería apagada o —peor— apagarla la guardaría encendida.
	Paused bool `json:"paused"`
}

func (MeetingReminder) TableName() string { return "meeting_reminders" }

// MeetingExclusion: a quién NO le llega esta reunión.
//
// Se guarda la excepción y no la lista, igual que `SpaceMute` con los canales.
// Con la lista, cada miembro nuevo de la organización habría que añadirlo a
// mano a la reunión de todos los lunes —o no se enteraría—, y cada baja
// dejaría filas apuntando a alguien que ya no está. Con exclusiones, entrar en
// la organización ya es estar convocado, que es lo que se pidió: todos
// marcados por defecto.
//
// El precio, dicho claro: una reunión de tres personas en una organización de
// cuarenta guarda treinta y siete filas. Si algún día pesa, se añade un campo
// que diga «sólo estos» sin tocar nada de lo demás.
type MeetingExclusion struct {
	MeetingID string `gorm:"type:varchar(36);primaryKey" json:"meetingId"`
	UserID    string `gorm:"type:varchar(36);primaryKey;index" json:"userId"`
}

func (MeetingExclusion) TableName() string { return "meeting_exclusions" }

// Las frecuencias que entiende la regla.
const (
	MeetingFreqDaily   = "daily"
	MeetingFreqWeekly  = "weekly"
	MeetingFreqMonthly = "monthly"
)

// ─── Peticiones y respuestas ─────────────────────────────────────────────────

type CreateMeetingRequest struct {
	Title    string `json:"title"    validate:"required,max=200"`
	WallTime string `json:"wallTime" validate:"required"`
	Timezone string `json:"timezone" validate:"required"`
	Freq     string `json:"freq"     validate:"required,oneof=daily weekly monthly"`
	Interval int    `json:"interval" validate:"omitempty,min=1,max=52"`
	Weekdays string `json:"weekdays"`
	MonthDay int    `json:"monthDay" validate:"omitempty,min=1,max=31"`
	Anchor   string `json:"anchor"`
	SpaceID  string `json:"spaceId"`
}

// UpdateMeetingRequest: campo ausente = no se toca. Punteros por la misma razón
// que en los canales — mandar el formulario entero para cambiar la hora es lo
// que hacía que editar borrara lo que no venías a tocar.
type UpdateMeetingRequest struct {
	Title    *string `json:"title"    validate:"omitempty,max=200"`
	WallTime *string `json:"wallTime"`
	Timezone *string `json:"timezone"`
	Freq     *string `json:"freq"     validate:"omitempty,oneof=daily weekly monthly"`
	Interval *int    `json:"interval" validate:"omitempty,min=1,max=52"`
	Weekdays *string `json:"weekdays"`
	MonthDay *int    `json:"monthDay" validate:"omitempty,min=1,max=31"`
	Anchor   *string `json:"anchor"`
	// SpaceID: "" desengancha la sala, un id la cambia.
	SpaceID *string `json:"spaceId"`
	Paused  *bool   `json:"paused"`
}

// MeetingRecipientsRequest reemplaza la lista de excluidos de una reunión.
type MeetingRecipientsRequest struct {
	ExcludedUserIDs []string `json:"excludedUserIds"`
}

// MeetingResponse es la reunión más lo que la pantalla necesita y no está en la
// fila: el nombre de la sala y a quién no le llega.
type MeetingResponse struct {
	MeetingReminder
	SpaceName       string   `json:"spaceName,omitempty"`
	ExcludedUserIDs []string `json:"excludedUserIds"`
}

// MeetingOccurrence es una vez concreta de una reunión, para pintar el
// calendario. Las expande el servidor: ver `occurrencesBetween`.
type MeetingOccurrence struct {
	MeetingID string    `json:"meetingId"`
	Title     string    `json:"title"`
	SpaceID   string    `json:"spaceId,omitempty"`
	SpaceName string    `json:"spaceName,omitempty"`
	Timezone  string    `json:"timezone"`
	Paused    bool      `json:"paused"`
	At        time.Time `json:"at"`
}

// MeetingRing es lo que viaja por SSE cuando llega la hora.
//
// Lleva la sala ya resuelta por nombre —como VoiceRing— para que la tarjeta se
// pinte sin ir a buscar nada, y `FiresAt` como instante para que cada quien lo
// formatee en su zona y al lado en la del organizador.
type MeetingRing struct {
	MeetingID string    `json:"meetingId"`
	Title     string    `json:"title"`
	SpaceID   string    `json:"spaceId,omitempty"`
	SpaceName string    `json:"spaceName,omitempty"`
	WallTime  string    `json:"wallTime"`
	Timezone  string    `json:"timezone"`
	FiresAt   time.Time `json:"firesAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}
