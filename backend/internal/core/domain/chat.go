package domain

import (
	"time"

	"gorm.io/gorm"
)

// ─── The space's channel of conversation ──────────────────────────────────────
//
// The fourth way of writing in cac, and the one that decides where the other
// three stay clean.
//
//   - A comment on an item is the record: anchored to one card, and a client may
//     be reading it.
//   - A doc is durable knowledge about a node.
//   - This is ambient coordination — "did you see portento-97?", "cutting a
//     release" — which until now went to WhatsApp or nowhere.
//
// The rule that keeps them apart is tempo, and it belongs in the composer's own
// placeholder: **if it is about a card, say it on the card**. Chat cites cards
// for everything else.
//
// One channel per space, existing by virtue of the space existing — nothing to
// create, nothing to join. Per list would have given this tree three near-dead
// channels per space and no home for the conversation that crosses folders,
// which is most of it.

// ChatMessage is one line in a space's channel.
//
// **There is deliberately no visibility column here, and there never should be.**
//
// Chat is internal, always: not to a tenant's API, not to a reporter, not down a
// webhook. Everywhere else in this codebase that distinction is a field, and a
// field can be defaulted wrong — this week a permissive default published a note
// meant for the team, and it took a constructor plus a source-scanning test to
// fence it. Here the fence is the schema: a table that cannot express "public"
// cannot leak by getting a flag wrong. The only way to publish one of these is
// to write a whole new code path, which is the kind of mistake somebody notices.
//
// The events it raises go through the hub only (the publish() pattern tasks
// use), never through emitItemEvent — that one dispatches webhooks.
type ChatMessage struct {
	BaseModel
	// SpaceID is the channel. Indexed with created_at because every read is
	// "the last N of this space".
	SpaceID string `gorm:"type:varchar(36);not null;index:idx_chat_space_time,priority:1" json:"spaceId"`
	// OrgID is denormalised, as everywhere else: the scoping check reads it and
	// walking up the tree for each message would be a join per line.
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// AuthorUserID is always a cac account. There are no reporters here and no
	// tenants — that whole discriminated-author model belongs to items, and
	// borrowing it would suggest an outsider could ever write in this table.
	AuthorUserID string `gorm:"type:varchar(36);index;not null" json:"authorUserId"`
	Body         string `gorm:"type:text;not null"             json:"body"`
	// Withdrawing hides; it does not destroy. The same choice the item threads
	// made — and the read below has to filter it explicitly, because a message
	// that stayed on screen after being deleted is a bug this codebase has
	// already shipped once.
	DeletedAt gorm.DeletedAt `gorm:"index;index:idx_chat_space_time,priority:3" json:"-"`
	CreatedAt time.Time      `gorm:"index:idx_chat_space_time,priority:2"      json:"createdAt"`
}

// ChatRead is how far someone has read in a channel.
//
// A timestamp rather than a message id: ids carry no order, and "everything
// after this moment" is exactly the question the badge asks.
type ChatRead struct {
	SpaceID    string    `gorm:"type:varchar(36);primaryKey" json:"spaceId"`
	UserID     string    `gorm:"type:varchar(36);primaryKey" json:"userId"`
	LastReadAt time.Time `json:"lastReadAt"`
}

// ChatAttachment is a file pasted into a channel.
//
// It hangs off the **space**, not off a message, because the upload happens
// while the message is still being typed — the same reason a task attachment
// tolerates not being cited by any saved text yet. Nothing here is reachable
// without belonging to the space's organization; the raw route checks that the
// way task and doc attachments already do.
type ChatAttachment struct {
	BaseModel
	SpaceID string `gorm:"type:varchar(36);index;not null" json:"spaceId"`
	// URL is our own proxy, relative — so the same markdown resolves against
	// whichever backend the app is pointed at.
	URL         string `gorm:"type:text"         json:"url"`
	Path        string `gorm:"type:text"         json:"-"`
	FileName    string `gorm:"type:varchar(255)" json:"fileName"`
	ContentType string `gorm:"type:varchar(120)" json:"contentType,omitempty"`
	Bytes       int64  `json:"bytes,omitempty"`
	UploadedBy  string `gorm:"type:varchar(36)" json:"uploadedBy,omitempty"`
}

// ChatAttachmentRef mirrors AttachmentRef and DocAttachmentRef: relative on
// purpose.
func ChatAttachmentRef(spaceID, attachmentID string) string {
	return "/api/v1/task-spaces/" + spaceID + "/chat/attachments/" + attachmentID + "/raw"
}

// ─── Requests / responses ─────────────────────────────────────────────────────

type ChatMessageRequest struct {
	Body string `json:"body" validate:"required,min=1,max=8000"`
}

// ChatMessageResponse carries the author's name so a channel renders without a
// lookup per line.
type ChatMessageResponse struct {
	ID           string    `json:"id"`
	SpaceID      string    `json:"spaceId"`
	AuthorUserID string    `json:"authorUserId"`
	AuthorName   string    `json:"authorName"`
	Body         string    `json:"body"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// ChatUnread is one space's unread count for the badge in the navigator.
type ChatUnread struct {
	SpaceID string `json:"spaceId"`
	Count   int64  `json:"count"`
}

// SpaceMute es quien **no** quiere enterarse de lo que se hable en un canal.
//
// Guarda la excepción, no la regla: por defecto todo miembro de la organización
// sigue todos sus canales, y aquí sólo caen los que se salieron de uno.
//
// Al revés —una tabla de «quién sigue»— poner a todo el mundo a seguir habría
// obligado a insertar una fila por miembro y por espacio, y a mantenerlas al
// alta de un miembro, al alta de un espacio y a la baja: tres sitios que se
// desincronizan y una verdad que hay que recalcular. Así no hay nada que
// rellenar ni que sincronizar, y salirse sigue siendo un acto explícito con su
// propia fila.
//
// `SpaceFollower` queda en la base sin que nadie la lea; retirarla es limpieza
// aparte.
type SpaceMute struct {
	SpaceID string `gorm:"type:varchar(36);primaryKey" json:"spaceId"`
	UserID  string `gorm:"type:varchar(36);primaryKey;index" json:"userId"`
}

// SpaceFollower: la tabla vieja, cuando seguir era opt-in. No la lee nadie.
type SpaceFollower struct {
	SpaceID string `gorm:"type:varchar(36);primaryKey" json:"spaceId"`
	UserID  string `gorm:"type:varchar(36);primaryKey;index" json:"userId"`
}

// VoiceTokenResponse es todo lo que la app necesita para entrar a una sala.
//
// La URL viaja con el token y no está fijada en el cliente: el SFU puede
// cambiar de sitio —otro host, otro puerto— sin que haya que publicar una
// versión de la app para seguirlo.
type VoiceTokenResponse struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	// Room viaja informativa, para que un log del cliente diga en qué sala
	// estaba. No se acepta de vuelta: la sala la decide el servidor.
	Room string `json:"room"`
}

// ─── El timbre de la voz ──────────────────────────────────────────────────────

// VoiceCaller es quien llama, con lo justo para pintar la tarjeta.
type VoiceCaller struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// VoiceRing es una llamada a una persona concreta para que entre a una sala.
//
// **No se guarda en ninguna parte.** Es un evento y no un registro: lo único
// que hace es hacer sonar un teléfono, y un teléfono que suena no es estado que
// haya que reconciliar. Guardarlo obligaría a limpiarlo —al colgar, al expirar,
// al reiniciar el proceso— y cada una de esas limpiezas es una manera nueva de
// dejar un timbre sonando para siempre.
//
// El tope de tiempo viaja en `ExpiresAt` y lo respetan los dos lados por su
// cuenta: quien llama deja de esperar, y a quien llaman se le apaga la tarjeta.
// Así, si la app de quien llama se cierra de golpe, el timbre se calla igual.
type VoiceRing struct {
	RingID    string      `json:"ringId"`
	SpaceID   string      `json:"spaceId"`
	SpaceName string      `json:"spaceName"`
	From      VoiceCaller `json:"from"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

// VoiceRingCancel retira un timbre antes de que expire.
//
// Va por persona y no por `ringId` a propósito. Sin estado en el servidor, un
// id opaco no dice a quién había que avisar de la cancelación: habría que
// guardar la correspondencia, que es justo lo que `VoiceRing` evita. «Deja de
// llamar a esta persona» es además idempotente y no necesita que quien cuelga
// se acuerde de nada.
type VoiceRingCancel struct {
	SpaceID string `json:"spaceId"`
	From    string `json:"from"`
}
