package domain

import "time"

// Notification is one thing that happened, kept for the person it happened to.
//
// The app already learns about events live, but only while it is open — the
// unread badge could never mean more than "since you last launched me". That
// gap is the whole reason this table exists: a row here outlives the session,
// so coming back after a day still tells you what you missed.
//
// One row per recipient rather than one per event with a join. A notification
// is read by one person, and "read" belongs to the row that person owns.
type Notification struct {
	BaseModel
	UserID string `gorm:"type:varchar(36);index:idx_notif_inbox,priority:1;not null" json:"-"`
	// OrgID scopes it, so switching organizations does not show another
	// client's traffic in your inbox.
	OrgID string `gorm:"type:varchar(36);index" json:"orgId"`
	// Kind is what happened, in the same vocabulary as the live events, so the
	// two paths can never disagree about what a thing is called.
	Kind  string `gorm:"type:varchar(40);not null" json:"kind"`
	Title string `gorm:"type:varchar(200);not null" json:"title"`
	Body  string `gorm:"type:varchar(400)" json:"body"`
	// Link is where this takes you when clicked — an in-app route. A
	// notification you cannot act on is just noise with a timestamp.
	Link string `gorm:"type:varchar(300)" json:"link"`
	// ReadAt nil means unread. A timestamp rather than a flag because "when did
	// I read this" is the question that orders an inbox.
	ReadAt *time.Time `gorm:"index:idx_notif_inbox,priority:2" json:"readAt,omitempty"`
	// Via es quién lo causó: la app (vacío) o el agente por MCP. Vacío es el
	// caso corriente y es también lo que tienen todas las filas anteriores a
	// esta columna, lo que es correcto: no fueron de un agente.
	Via string `gorm:"type:varchar(10)" json:"via,omitempty"`
}

// NotificationPrefs is what somebody wants to be told about.
//
// Booleans and not a list of enabled kinds, so a kind added later starts on for
// everybody instead of off for everybody: a notification nobody asked to lose
// is a worse default than one they have to turn off.
//
// Absent row means "everything on". Nobody has to opt in to being told they
// were named — that is the point of being named.
type NotificationPrefs struct {
	UserID string `gorm:"type:varchar(36);primaryKey" json:"-"`
	// Mentions is deliberately not offered as something to disable in the UI:
	// it is here so the shape is complete, and it stays true. Somebody naming
	// you is the one thing this product should never quietly swallow.
	// No `default:true` on any of these, deliberately. GORM treats `false` as a
	// zero value and substitutes the column default on insert, so a column
	// defaulting to true made "turn this off" store itself as on — a setting
	// that silently did nothing. The default for somebody with no row at all is
	// handled in code instead; see DefaultPrefs.
	// MeetingsQuiet apaga los recordatorios de reuniones periódicas.
	//
	// Invertido como WorkQuiet y por lo mismo: la columna nace en el cero de su
	// tipo para todo el que ya tenga preferencias guardadas, y ese cero tiene que
	// significar «sí, avísame» — que es lo que espera quien nunca ha tocado esto.
	//
	// Existe porque sin él una reunión sería el único aviso **recurrente** de la
	// app imposible de silenciar: cae en el `return true` del final, que está
	// pensado para clases nuevas y sueltas, no para algo que suena cada martes.
	MeetingsQuiet bool `json:"meetingsQuiet"`
	Mentions      bool `json:"mentions"`
	DMs           bool `json:"dms"`
	Comments      bool `json:"comments"`
	Reports       bool `json:"reports"`
	// WorkQuiet apaga los avisos de tu propio trabajo: que te asignen algo, que
	// cambie de estado.
	//
	// **Invertido, y es la única de estas que lo está.** Una columna nueva sobre
	// una tabla con filas nace en el cero de su tipo, así que un `Work bool`
	// habría llegado en `false` para todo el que ya tuviera preferencias
	// guardadas — es decir, apagado justo para quien más usa esto, y sin que
	// nadie lo pidiera. Al revés, el cero significa «no lo he apagado», que es
	// lo que se quiere decir. El comentario de arriba explica por qué tampoco
	// vale un `default:true`.
	WorkQuiet bool `json:"workQuiet"`
	// Messages son los mensajes corrientes de los canales que sigues. Sólo
	// llegan de ahí: seguir es lo que los pide, y esto es lo que los calla sin
	// tener que dejar de seguir el canal.
	Messages bool `json:"messages"`
}

// DefaultPrefs is what somebody who has never touched this gets.
func DefaultPrefs(userID string) NotificationPrefs {
	return NotificationPrefs{
		UserID: userID, Mentions: true, DMs: true, Comments: true, Reports: true, Messages: true,
	}
}

// Allows answers whether a kind should be recorded at all.
func (p NotificationPrefs) Allows(kind string) bool {
	switch kind {
	case "chat:mention":
		return true // never silenced; see the field comment
	case "dm:message":
		return p.DMs
	case "task:comment":
		return p.Comments
	case "report:new":
		return p.Reports
	case "chat:message":
		return p.Messages
	case "task:assigned", "task:status":
		return !p.WorkQuiet
	case "meeting:reminder":
		return !p.MeetingsQuiet
	}
	return true
}

// NotificationFeed is what the panel shows: the notifications and the number
// the badge needs, so it takes one request and not two.
type NotificationFeed struct {
	Items  []Notification `json:"items"`
	Unread int64          `json:"unread"`
}
