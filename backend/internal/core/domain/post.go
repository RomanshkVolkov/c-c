package domain

import "time"

// El muro: lo que las organizaciones y la plataforma se dicen entre sí.
//
// Dos clases de publicación. Un **comunicado** lo publica la plataforma (un
// superadmin) y lo ve todo el mundo. Un **feedback** lo publica una
// organización, y quien lo escribe decide quién lo lee: sólo el equipo de cac
// (`platform`, que también ve su propia organización) o todas las
// organizaciones (`everyone`).
//
// Quién ve qué se decide en un solo sitio (service/post.go, `canSee`) y lo usan
// todas las rutas: el muro, el detalle, comentar, reaccionar y servir una
// imagen. Una ruta que lo decidiera por su cuenta sería la que dejara a una
// organización leer lo que otra escribió «sólo para cac».

const (
	PostAnnouncement = "announcement"
	PostFeedback     = "feedback"

	AudiencePlatform = "platform"
	AudienceEveryone = "everyone"
)

type Post struct {
	BaseModel
	AuthorID string `gorm:"type:varchar(36);index;not null" json:"authorId"`
	// OrgID: la organización que publica. Vacía en un comunicado, que es de la
	// plataforma y no de ninguna.
	OrgID    string `gorm:"type:varchar(36);index" json:"orgId"`
	Kind     string `gorm:"type:varchar(20);not null" json:"kind"`
	Audience string `gorm:"type:varchar(20);not null" json:"audience"`
	Title    string `gorm:"type:varchar(140)" json:"title"`
	Body     string `gorm:"type:text;not null" json:"body"`
	// EditedAt: la última vez que su autor la cambió. Nil si nunca.
	EditedAt *time.Time `json:"editedAt,omitempty"`
	// PinnedAt: fijada arriba del muro por un superadmin, y desde cuándo.
	PinnedAt *time.Time `gorm:"index" json:"pinnedAt,omitempty"`
	// Via: por dónde entró (ver via.go). `mcp` la publicó un agente con el
	// token de su autor, y la tarjeta lo dice.
	Via string `gorm:"type:varchar(10)" json:"via,omitempty"`
	// Draft: redactado pero sin publicar. Lo ve sólo su autor. Es como queda un
	// comunicado que redacta un agente: lo revisa y lo publica una persona
	// (`PostService.Publish`), porque llega a todas las organizaciones.
	Draft bool `gorm:"not null;default:false;index" json:"draft"`
}

type PostComment struct {
	BaseModel
	PostID   string `gorm:"type:varchar(36);index;not null" json:"postId"`
	AuthorID string `gorm:"type:varchar(36);not null" json:"authorId"`
	Body     string `gorm:"type:text;not null" json:"body"`
	Via      string `gorm:"type:varchar(10)" json:"via,omitempty"`
}

// PostAttachment es una imagen de una publicación o de un comentario.
//
// Se sube mientras se escribe, así que nace sin publicación (como la del chat
// nace sin mensaje) y se engancha al publicar, por la ruta que cita el cuerpo.
// Hasta entonces sólo la ve quien la subió; después, quien vea la publicación.
type PostAttachment struct {
	BaseModel
	PostID      string `gorm:"type:varchar(36);index" json:"postId,omitempty"`
	OrgID       string `gorm:"type:varchar(36)" json:"orgId,omitempty"`
	UploadedBy  string `gorm:"type:varchar(36);not null" json:"uploadedBy"`
	URL         string `gorm:"type:text" json:"url"`
	Path        string `gorm:"type:text" json:"-"`
	FileName    string `gorm:"type:varchar(255)" json:"fileName"`
	ContentType string `gorm:"type:varchar(120)" json:"contentType,omitempty"`
	Bytes       int64  `json:"bytes,omitempty"`
}

// PostAttachmentRef: relativa, como las del chat, para que el mismo markdown
// valga contra el backend al que apunte la app.
func PostAttachmentRef(attachmentID string) string {
	return "/api/v1/posts/attachments/" + attachmentID + "/raw"
}

// PostRead: hasta cuándo vio alguien el muro. Una fila por persona y no una por
// persona y publicación: «nuevo» es lo publicado después.
type PostRead struct {
	UserID string    `gorm:"type:varchar(36);primaryKey" json:"userId"`
	SeenAt time.Time `gorm:"not null" json:"seenAt"`
}

// ─── Requests / responses ─────────────────────────────────────────────────────

type CreatePostRequest struct {
	// OrgID: la organización en nombre de la que se publica un feedback. Se
	// ignora en un comunicado.
	OrgID    string `json:"orgId" validate:"max=36"`
	Kind     string `json:"kind" validate:"required,oneof=announcement feedback"`
	Audience string `json:"audience" validate:"omitempty,oneof=platform everyone"`
	Title    string `json:"title" validate:"max=140"`
	Body     string `json:"body" validate:"required,min=1,max=20000"`
}

// UpdatePostRequest: lo que puede cambiar quien la escribió. Nil es «igual».
// La audiencia sólo en un feedback: un comunicado es siempre de todos.
type UpdatePostRequest struct {
	Title    *string `json:"title" validate:"omitempty,max=140"`
	Body     *string `json:"body" validate:"omitempty,min=1,max=20000"`
	Audience *string `json:"audience" validate:"omitempty,oneof=platform everyone"`
}

type PinPostRequest struct {
	Pinned bool `json:"pinned"`
}

type CreatePostCommentRequest struct {
	Body string `json:"body" validate:"required,min=1,max=8000"`
}

type PostResponse struct {
	ID         string            `json:"id"`
	Kind       string            `json:"kind"`
	Audience   string            `json:"audience"`
	OrgID      string            `json:"orgId,omitempty"`
	OrgName    string            `json:"orgName,omitempty"`
	AuthorID   string            `json:"authorId"`
	AuthorName string            `json:"authorName"`
	Title      string            `json:"title"`
	Body       string            `json:"body"`
	CreatedAt  time.Time         `json:"createdAt"`
	Comments   int               `json:"comments"`
	Reactions  []ReactionSummary `json:"reactions"`
	// Unseen: publicado después de la última vez que quien mira abrió el muro.
	Unseen    bool       `json:"unseen"`
	CanDelete bool       `json:"canDelete"`
	CanEdit   bool       `json:"canEdit"`
	CanPin    bool       `json:"canPin"`
	Pinned    bool       `json:"pinned"`
	EditedAt  *time.Time `json:"editedAt,omitempty"`
	Via       string     `json:"via,omitempty"`
	Draft     bool       `json:"draft"`
	// CanPublish: es un borrador tuyo y lo puedes publicar (una persona, no
	// un token).
	CanPublish bool `json:"canPublish"`
}

type PostCommentResponse struct {
	ID         string    `json:"id"`
	PostID     string    `json:"postId"`
	AuthorID   string    `json:"authorId"`
	AuthorName string    `json:"authorName"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"createdAt"`
	CanDelete  bool      `json:"canDelete"`
	Via        string    `json:"via,omitempty"`
	// Reactions: las de este comentario (destino `post_comment`).
	Reactions []ReactionSummary `json:"reactions" gorm:"-"`
}

type PostDetailResponse struct {
	PostResponse
	CommentList []PostCommentResponse `json:"commentList"`
}

type PostPage struct {
	Posts      []PostResponse `json:"posts"`
	NextCursor string         `json:"nextCursor,omitempty"`
}
