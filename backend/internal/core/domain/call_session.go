package domain

import (
	"strconv"
	"time"
)

// Una llamada, guardada. Hasta el 15-oct-2026 una sala era sólo un nombre
// (`voice:<canal>`, `meet:<invitación>`) y de una llamada terminada no quedaba
// nada, salvo el aviso de la grabación si se grabó. Ahora cada vez que alguien
// entra a una sala que no tiene sesión abierta se abre una, y al vaciarse se
// cierra y deja **un solo mensaje en el canal**: cuánto duró, quién estuvo y,
// si se grabó, la grabación. Es la tanda 2 del plan del chat de la llamada; el
// chat propio cuelga de esta sesión en la tanda 3.
//
// **Se abre al dar la entrada**, no al ver gente dentro: es el único momento
// en que el servidor sabe a qué sala va alguien sin preguntarle al SFU. Y **se
// cierra con un reloj**, que pregunta al SFU quién está, con la misma forma
// que el de la grabación (ver `RecordingService.Tick`): dos vueltas vacías y
// no una, para que una reconexión de diez segundos no parta la llamada en dos.
// No hay webhooks del SFU, y está escrito por qué (`service/voice.go`).

// CallSession: una llamada, de que entra el primero a que se va el último.
type CallSession struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// SpaceID es el canal donde se resume: el de la sala, o el del que cuelga
	// la invitación. Sin canal (una invitación suelta) no hay resumen.
	SpaceID *string `gorm:"type:varchar(36);index" json:"spaceId,omitempty"`
	// Room es la sala del SFU. **Como mucho una sesión abierta por sala**, y lo
	// dice el índice y no un candado en memoria: dos entradas a la vez desde
	// dos réplicas abren una sola (ver CallSessionRepository.Open).
	Room     string  `gorm:"type:varchar(120);not null;uniqueIndex:idx_call_session_open,where:ended_at IS NULL" json:"room"`
	InviteID *string `gorm:"type:varchar(36)" json:"inviteId,omitempty"`
	// StartedBy: quien la abrió. Firma el resumen, como quien grabó firma el
	// aviso de la grabación, y por lo mismo (ver RecordingAnnouncement).
	StartedBy string     `gorm:"type:varchar(36);not null" json:"startedBy"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `gorm:"index" json:"endedAt,omitempty"`
	// LastSeenAt: la última vez que el reloj vio a alguien dentro. Es el
	// final de verdad: cerrar con la hora del segundo tick vacío sumaría veinte
	// segundos de sala vacía a cada llamada.
	LastSeenAt *time.Time `json:"-"`
	// TickedAt y EmptyTicks son del reloj, como en Recording.
	TickedAt   time.Time `gorm:"index" json:"-"`
	EmptyTicks int       `json:"-"`
	// SummaryMessageID: el mensaje del canal que la resume, para editarlo
	// cuando la grabación quede lista en vez de poner otro.
	SummaryMessageID *string `gorm:"type:varchar(36)" json:"-"`
	RecordingID      *string `gorm:"type:varchar(36)" json:"recordingId,omitempty"`
}

func (CallSession) TableName() string { return "call_sessions" }

// CallSessionParticipant: alguien que estuvo, visto por el reloj.
//
// Lo apunta el reloj y no la entrada: tener la entrada no es haber entrado, y
// el resumen dice quién estuvo.
type CallSessionParticipant struct {
	SessionID     string    `gorm:"type:varchar(36);primaryKey" json:"-"`
	Identity      string    `gorm:"type:varchar(120);primaryKey" json:"identity"`
	Name          string    `gorm:"type:varchar(120)" json:"name"`
	Guest         bool      `json:"guest"`
	FirstJoinedAt time.Time `json:"firstJoinedAt"`
}

func (CallSessionParticipant) TableName() string { return "call_session_participants" }

// CallSessionResponse: el resumen de una llamada, para la tarjeta del canal.
type CallSessionResponse struct {
	ID           string                   `json:"id"`
	SpaceID      *string                  `json:"spaceId,omitempty"`
	StartedAt    time.Time                `json:"startedAt"`
	EndedAt      *time.Time               `json:"endedAt,omitempty"`
	DurationMs   int64                    `json:"durationMs"`
	Participants []CallSessionParticipant `json:"participants"`
	RecordingID  *string                  `json:"recordingId,omitempty"`
}

// CallMinimum: una llamada más corta que esto, de una sola persona y sin
// mensajes, no deja resumen. Es un clic por error, o entrar a ver si había
// alguien: dejar una línea en el canal por eso sería ruido.
const CallMinimum = 30 * time.Second

// WorthSummarizing: si una llamada merece su línea en el canal.
func WorthSummarizing(duration time.Duration, people, messages int) bool {
	if people == 0 {
		return false
	}
	return duration >= CallMinimum || people > 1 || messages > 0
}

// CallSummary: la línea del canal cuando una llamada termina.
//
// Las mismas reglas que RecordingAnnouncement: en inglés —es una fila que
// leen varios—, sin primera persona y sin nombrar a nadie, porque una app que
// no conoce `kind` la pinta firmada por quien abrió la llamada. La app nueva
// no lee esta frase: pinta una tarjeta a partir del enlace `cac:call/<id>`.
//
// La grabación entra en la misma línea, cuando la hay y está lista: el resumen
// **sustituye** al aviso de la grabación, que si no serían dos líneas de la
// misma llamada.
func CallSummary(sessionID string, duration time.Duration, people int, rec *Recording) (body, notice string) {
	what := "Call ended"
	if d := CallLength(duration); d != "" {
		what += " · " + d
	}
	if people == 1 {
		what += " · 1 person"
	} else if people > 1 {
		what += " · " + strconv.Itoa(people) + " people"
	}
	body = what + " — [details](" + CallRef(sessionID) + ")"
	if rec != nil && (rec.Status == RecordingReady || rec.Status == RecordingPartial) {
		body += " · [watch the recording](" + RecordingRef(rec.ID) + ")"
		what += " · recorded"
	}
	return body + ".", what + "."
}

// CallLength: «45 s», «12 min», «1 h 05 min». Redondeado al minuto pasado el
// primero: el resumen dice cuánto fue, no un cronómetro.
func CallLength(d time.Duration) string {
	if d <= 0 {
		return ""
	}
	if d < time.Minute {
		return strconv.Itoa(int(d.Seconds())) + " s"
	}
	m := int((d + 30*time.Second) / time.Minute)
	if m < 60 {
		return strconv.Itoa(m) + " min"
	}
	mm := strconv.Itoa(m % 60)
	if len(mm) == 1 {
		mm = "0" + mm
	}
	return strconv.Itoa(m/60) + " h " + mm + " min"
}
