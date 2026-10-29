package domain

import "time"

// DecisionLink: una decisión enlazada a una tarea o a una sección de un doc
// (command-and-control-91).
//
// Una decisión suele tocar varias tareas, y la sección del runbook que la
// aplica es donde alguien va a preguntarse por qué algo está así. El origen
// (`Decision.OriginTaskID`) es una sola tarea y dice de dónde salió; los
// enlaces dicen a qué afecta, y el origen es también uno de ellos.
//
// **Append-only, como el registro.** Quitar un enlace lo marca (`RemovedAt`,
// `RemovedByID`) y no lo borra: que una decisión dejó de aplicarse a algo es
// parte de su historia.
type DecisionLink struct {
	BaseModel
	OrgID      string  `gorm:"type:varchar(36);not null;index" json:"-"`
	DecisionID string  `gorm:"type:varchar(36);not null;index" json:"decisionId"`
	TaskID     *string `gorm:"type:varchar(36);index" json:"taskId,omitempty"`
	SectionID  *string `gorm:"type:varchar(36);index" json:"sectionId,omitempty"`
	AddedByID  string  `gorm:"type:varchar(36)" json:"-"`
	// Via: por dónde entró, la app o un agente. Ver `Decision.Via`.
	Via         string     `gorm:"type:varchar(20)" json:"via,omitempty"`
	RemovedAt   *time.Time `json:"removedAt,omitempty"`
	RemovedByID string     `gorm:"type:varchar(36)" json:"-"`
}

const (
	DecisionLinkTask    = "task"
	DecisionLinkSection = "section"
)

// DecisionLinkView: un enlace vivo tal como se pinta, con palabras y no con
// identificadores.
type DecisionLinkView struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // task | section

	TaskID     string `json:"taskId,omitempty"`
	TaskRef    string `json:"taskRef,omitempty"`
	TaskTitle  string `json:"taskTitle,omitempty"`
	TaskStatus string `json:"taskStatus,omitempty"`

	SectionID string `json:"sectionId,omitempty"`
	// Heading: el título de ahora, o el último que tuvo si se quitó.
	Heading string `json:"heading,omitempty"`
	// SectionRemoved: la sección ya no está en su pestaña o página.
	SectionRemoved bool         `json:"sectionRemoved,omitempty"`
	Tab            DocTabKey    `json:"tab,omitempty"`
	PageID         string       `json:"pageId,omitempty"`
	PageTitle      string       `json:"pageTitle,omitempty"`
	OwnerKind      DocOwnerKind `json:"ownerKind,omitempty"`
	OwnerID        string       `json:"ownerId,omitempty"`

	AddedAt time.Time `json:"addedAt"`
	Via     string    `json:"via,omitempty"`
}

// DecisionLinksRequest: lo que se enlaza a una decisión que ya existe.
type DecisionLinksRequest struct {
	TaskIDs    []string `json:"taskIds"    validate:"max=50,dive,max=36"`
	SectionIDs []string `json:"sectionIds" validate:"max=50,dive,max=36"`
}

// DecisionRef: una decisión vigente nombrada desde algo que la aplica (una
// sección, una tarea).
type DecisionRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Dónde vive, para abrirla en su registro.
	OwnerKind      DocOwnerKind `json:"ownerKind,omitempty"`
	OwnerID        string       `json:"ownerId,omitempty"`
	DecidedAt      time.Time    `json:"decidedAt"`
	SupersededByID string       `json:"supersededById,omitempty"`
}

// DocSectionHit: una sección encontrada para enlazarla, con dónde vive.
type DocSectionHit struct {
	ID        string       `json:"id"`
	Heading   string       `json:"heading"`
	Level     int          `json:"level"`
	Tab       DocTabKey    `json:"tab,omitempty"`
	PageID    string       `json:"pageId,omitempty"`
	PageTitle string       `json:"pageTitle,omitempty"`
	OwnerKind DocOwnerKind `json:"ownerKind"`
	OwnerID   string       `json:"ownerId"`
	OwnerName string       `json:"ownerName"`
}
