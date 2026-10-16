package domain

import (
	"slices"
	"time"
)

// Reacciones: un emoji sobre un mensaje, de quien lo pone.
//
// **Una tabla para los tres chats** —el del canal, los directos y, más
// adelante, el de la llamada—, distinguidos por `Target`. Las reacciones no
// llevan texto, así que juntarlas no arriesga lo que separa a esos chats en
// tablas propias (que una consulta del canal devuelva un directo, ver dm.go):
// quién puede verlas se comprueba siempre contra el mensaje, nunca aquí.
//
// `ActorID` y no `UserID`: hoy es siempre una cuenta, pero en el chat de la
// llamada reaccionará también un invitado (`guest:<id>`), y la columna ya se
// llama como lo que va a ser.

type ReactionTarget string

const (
	ReactionChannel ReactionTarget = "channel"
	ReactionDM      ReactionTarget = "dm"
	// ReactionCall: un mensaje del chat de una llamada (domain/call_message.go).
	ReactionCall ReactionTarget = "call"
)

// ReactionEmojis es el juego cerrado que se acepta, en el orden del selector.
//
// Cerrado a propósito: cubre lo que de verdad se usa para contestar sin
// escribir, y un selector completo son cientos de KB en una app que se descarga
// entera. Y validado en el servidor, porque es texto libre que acaba pintado en
// la pantalla de otra persona.
var ReactionEmojis = []string{"👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🔥"}

// ValidReaction: si un emoji es de los que se aceptan.
func ValidReaction(emoji string) bool {
	return slices.Contains(ReactionEmojis, emoji)
}

// ChatReaction es una persona poniendo un emoji en un mensaje. La clave es la
// fila entera menos la fecha: poner dos veces el mismo es ponerlo una.
type ChatReaction struct {
	Target    ReactionTarget `gorm:"type:varchar(12);primaryKey" json:"target"`
	MessageID string         `gorm:"type:varchar(36);primaryKey" json:"messageId"`
	ActorID   string         `gorm:"type:varchar(80);primaryKey" json:"actorId"`
	Emoji     string         `gorm:"type:varchar(16);primaryKey" json:"emoji"`
	CreatedAt time.Time      `json:"createdAt"`
}

func (ChatReaction) TableName() string { return "chat_reactions" }

// ReactionRequest: poner (`on`) o quitar un emoji.
type ReactionRequest struct {
	Emoji string `json:"emoji" validate:"required,max=16"`
	On    bool   `json:"on"`
}

// ReactionSummary es un emoji de un mensaje, ya contado: lo que pinta la app.
type ReactionSummary struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	// Mine: si quien pregunta está entre ellos, para pintarlo marcado y que
	// pulsarlo lo quite.
	Mine bool `json:"mine"`
	// Names: quiénes, en el orden en que reaccionaron, para el «quién» al pasar
	// el ratón.
	Names []string `json:"names"`
}
