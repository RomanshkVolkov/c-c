package repository

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

// El muro (ver domain/post.go). Aquí no se decide quién ve qué, salvo en el
// listado: filtrar en Go una página ya cortada dejaría páginas medio vacías,
// así que la regla de `canSee` se repite en SQL, y una prueba compara las dos.

var ErrPostNotFound = errors.New("post not found")

type PostRepository struct{ db *gorm.DB }

func NewPostRepository(db *gorm.DB) *PostRepository { return &PostRepository{db: db} }

// PostRow: una publicación con lo que hace falta para pintarla.
type PostRow struct {
	domain.Post
	AuthorName string
	OrgName    string
	Comments   int
}

// postSelect: los nombres salen de subconsultas y no de un JOIN porque
// `nombreVisible` nombra las columnas sin tabla.
const postSelect = `p.*,
	COALESCE((SELECT ` + nombreVisible + ` FROM users WHERE id = p.author_id), '') AS author_name,
	COALESCE((SELECT name FROM organizations WHERE id = p.org_id), '') AS org_name,
	(SELECT count(*) FROM post_comments c WHERE c.post_id = p.id) AS comments`

// isAnnouncement ordena los comunicados delante. La paginación sigue la misma
// clave (comunicado, fecha, id), así que la segunda página empieza justo donde
// acabó la primera aunque mezcle las dos clases.
const isAnnouncement = `(CASE WHEN p.kind = 'announcement' THEN 1 ELSE 0 END)`

// PostCursor: dónde acabó la página anterior.
type PostCursor struct {
	Announcement int
	At           time.Time
	ID           string
}

// List: lo que ve alguien, comunicados primero y después lo más nuevo. `all`
// es el superadmin; `orgs`, las organizaciones de quien mira.
func (r *PostRepository) List(orgs []string, all bool, after *PostCursor, limit int) ([]PostRow, error) {
	q := r.db.Table("posts p").Select(postSelect)
	if !all {
		// La regla de canSee (service/post.go), en SQL.
		q = q.Where("p.kind = ? OR p.audience = ? OR p.org_id IN ?",
			domain.PostAnnouncement, domain.AudienceEveryone, append(orgs, ""))
		if len(orgs) == 0 {
			// Sin organización sólo hay comunicados: «para todos» es para
			// quien es de alguna.
			q = r.db.Table("posts p").Select(postSelect).Where("p.kind = ?", domain.PostAnnouncement)
		}
	}
	if after != nil {
		q = q.Where("("+isAnnouncement+", p.created_at, p.id) < (?, ?, ?)", after.Announcement, after.At, after.ID)
	}
	var rows []PostRow
	err := q.Order(isAnnouncement + " DESC, p.created_at DESC, p.id DESC").Limit(limit).Scan(&rows).Error
	return rows, err
}

func (r *PostRepository) Find(id string) (*PostRow, error) {
	var row PostRow
	err := r.db.Table("posts p").Select(postSelect).Where("p.id = ?", id).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPostNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// Create guarda la publicación y engancha las imágenes que cita su cuerpo.
func (r *PostRepository) Create(p *domain.Post, attachmentIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(p).Error; err != nil {
			return err
		}
		return claimAttachments(tx, p.ID, p.AuthorID, attachmentIDs)
	})
}

// AddComment: lo mismo para un comentario. Sus imágenes también cuelgan de la
// publicación: las ve quien vea la publicación.
func (r *PostRepository) AddComment(c *domain.PostComment, attachmentIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(c).Error; err != nil {
			return err
		}
		return claimAttachments(tx, c.PostID, c.AuthorID, attachmentIDs)
	})
}

// claimAttachments: sólo las de quien escribe y sólo las que aún no tienen
// publicación. Citar en tu cuerpo la imagen de otra persona no te la da.
func claimAttachments(tx *gorm.DB, postID, authorID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	return tx.Model(&domain.PostAttachment{}).
		Where("id IN ? AND uploaded_by = ? AND (post_id = '' OR post_id IS NULL)", ids, authorID).
		Update("post_id", postID).Error
}

func (r *PostRepository) Comments(postID string) ([]domain.PostCommentResponse, error) {
	var out []domain.PostCommentResponse
	err := r.db.Table("post_comments c").
		Select(`c.id, c.post_id, c.author_id, c.body, c.created_at,
			COALESCE((SELECT `+nombreVisible+` FROM users WHERE id = c.author_id), '') AS author_name`).
		Where("c.post_id = ?", postID).Order("c.created_at, c.id").Scan(&out).Error
	return out, err
}

func (r *PostRepository) FindComment(postID, commentID string) (*domain.PostComment, error) {
	var c domain.PostComment
	err := r.db.Where("id = ? AND post_id = ?", commentID, postID).Take(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPostNotFound
	}
	return &c, err
}

func (r *PostRepository) DeleteComment(id string) error {
	return r.db.Delete(&domain.PostComment{}, "id = ?", id).Error
}

// CommenterIDs: quienes ya comentaron, para avisarles del siguiente.
func (r *PostRepository) CommenterIDs(postID string) ([]string, error) {
	var ids []string
	err := r.db.Model(&domain.PostComment{}).Where("post_id = ?", postID).Distinct().Pluck("author_id", &ids).Error
	return ids, err
}

// Delete se lleva la publicación entera: comentarios, reacciones e imágenes.
// Las filas de las imágenes; los ficheros se quedan en el bucket, sin nadie que
// los pueda pedir (la ruta mira la fila).
func (r *PostRepository) Delete(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, q := range []*gorm.DB{
			tx.Where("post_id = ?", id).Delete(&domain.PostComment{}),
			tx.Where("target = ? AND message_id = ?", domain.ReactionPost, id).Delete(&domain.ChatReaction{}),
			tx.Where("post_id = ?", id).Delete(&domain.PostAttachment{}),
			tx.Delete(&domain.Post{}, "id = ?", id),
		} {
			if q.Error != nil {
				return q.Error
			}
		}
		return nil
	})
}

func (r *PostRepository) CreateAttachment(a *domain.PostAttachment) error {
	return r.db.Create(a).Error
}

func (r *PostRepository) FindAttachment(id string) (*domain.PostAttachment, error) {
	var a domain.PostAttachment
	err := r.db.Where("id = ?", id).Take(&a).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPostNotFound
	}
	return &a, err
}

// SeenAt: hasta cuándo vio el muro alguien. Cero si nunca lo abrió.
func (r *PostRepository) SeenAt(userID string) time.Time {
	var row domain.PostRead
	if err := r.db.Where("user_id = ?", userID).Take(&row).Error; err != nil {
		return time.Time{}
	}
	return row.SeenAt
}

func (r *PostRepository) MarkSeen(userID string, at time.Time) error {
	return r.db.Save(&domain.PostRead{UserID: userID, SeenAt: at}).Error
}

// StillSees: si alguien puede ver hoy una publicación «sólo para cac», sin su
// token (que es de otra persona): por su membresía o por ser superadmin. Para
// los avisos; las rutas usan las claims de quien pide.
func (r *PostRepository) StillSees(userID string, p *domain.Post) bool {
	if p.Kind == domain.PostAnnouncement {
		return true
	}
	var n int64
	q := r.db.Table("users u").Where("u.id = ?", userID)
	if p.Audience == domain.AudienceEveryone {
		q = q.Where("u.is_superadmin OR EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = u.id)")
	} else {
		q = q.Where("u.is_superadmin OR EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = u.id AND m.org_id = ?)", p.OrgID)
	}
	q.Count(&n)
	return n > 0
}

// DisplayName: cómo se llama alguien, para un aviso.
func (r *PostRepository) DisplayName(userID string) string {
	var name string
	r.db.Raw(`SELECT `+nombreVisible+` FROM users WHERE id = ?`, userID).Scan(&name)
	return name
}

// SuperadminIDs: a quién le llega el feedback nuevo. Ver DocRepository.
func (r *PostRepository) SuperadminIDs() ([]string, error) {
	var ids []string
	err := r.db.Model(&domain.User{}).Where("is_superadmin = ?", true).Pluck("id", &ids).Error
	return ids, err
}
