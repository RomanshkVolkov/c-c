package domain

import (
	"time"

	"gorm.io/gorm"
)

// El chat de la llamada: lo que se escribe mientras dura, para quien está
// dentro, y consultable después desde el resumen del canal. Es la tanda 3 del
// plan (domain/call_session.go es la 2).
//
// **Una tabla propia y no `chat_messages`**: el chat del canal exige una
// cuenta de cac como autor, a propósito, y en una llamada escriben también los
// invitados por enlace (tanda 4). Por eso el autor es o un usuario o un
// invitado, y el nombre se guarda: un invitado no tiene fila en `users` donde
// buscarlo.
type CallMessage struct {
	BaseModel
	SessionID string `gorm:"type:varchar(36);not null;index:idx_call_message_time,priority:1" json:"sessionId"`
	OrgID     string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// Uno de los dos. El del invitado llega en la tanda 4.
	AuthorUserID  *string `gorm:"type:varchar(36);index" json:"authorUserId,omitempty"`
	AuthorGuestID *string `gorm:"type:varchar(36)" json:"authorGuestId,omitempty"`
	AuthorName    string  `gorm:"type:varchar(120);not null" json:"authorName"`
	Body          string  `gorm:"type:text;not null" json:"body"`
	// Retirar oculta, como en el canal; la lectura lo filtra.
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
	CreatedAt time.Time      `gorm:"index:idx_call_message_time,priority:2" json:"createdAt"`
}

func (CallMessage) TableName() string { return "call_messages" }

type CallMessageRequest struct {
	Body string `json:"body" validate:"required,min=1,max=8000"`
}

// CallMessageResponse: un mensaje con sus reacciones, contadas para quien
// pregunta.
type CallMessageResponse struct {
	CallMessage
	Reactions []ReactionSummary `json:"reactions"`
}

// GuestChatRequest: el invitado, que no tiene sesión de cac, se identifica con
// el enlace firmado y su pase, como en `status` (tanda 4). Body sólo al
// escribir.
type GuestChatRequest struct {
	Token string `json:"token" validate:"required"`
	Pass  string `json:"pass" validate:"required"`
	Body  string `json:"body" validate:"omitempty,max=8000"`
}
