package repository

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var (
	ErrConversationNotFound = errors.New("conversation not found")
	ErrDMMessageNotFound    = errors.New("message not found")
	// ErrNotColleagues: the two people don't share the organization the
	// conversation would belong to.
	ErrNotColleagues = errors.New("you don't share an organization with that person")
)

type DMRepository struct {
	db *gorm.DB
}

func NewDMRepository(db *gorm.DB) *DMRepository { return &DMRepository{db: db} }

// OpenWith finds or creates the conversation between two people in one org.
//
// Both directions land on the same row because the pair is stored sorted and
// the unique index is on the sorted triple. Two people opening a thread with
// each other at the same moment is a real race — the insert can lose it — so a
// conflict is answered by reading the winner's row rather than by failing.
func (r *DMRepository) OpenWith(orgID, userID, otherID string) (*domain.DMConversation, error) {
	if orgID == "" || userID == "" || otherID == "" || userID == otherID {
		return nil, ErrConversationNotFound
	}
	// Both must be in this organization. Checked here and not only at the
	// handler because this is the door every write goes through.
	var members int64
	if err := r.db.Raw(`
		SELECT COUNT(*) FROM org_memberships WHERE org_id = ? AND user_id IN ?
	`, orgID, []string{userID, otherID}).Scan(&members).Error; err != nil {
		return nil, err
	}
	if members < 2 {
		return nil, ErrNotColleagues
	}

	lo, hi := domain.SortPair(userID, otherID)
	var c domain.DMConversation
	err := r.db.Where("org_id = ? AND user_lo_id = ? AND user_hi_id = ?", orgID, lo, hi).First(&c).Error
	if err == nil {
		return &c, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	c = domain.DMConversation{OrgID: orgID, UserLoID: lo, UserHiID: hi}
	c.ID = uuid.NewString()
	if err := r.db.Create(&c).Error; err != nil {
		// Lost the race: somebody created it between the read and the write.
		var existing domain.DMConversation
		if e := r.db.Where("org_id = ? AND user_lo_id = ? AND user_hi_id = ?", orgID, lo, hi).
			First(&existing).Error; e == nil {
			return &existing, nil
		}
		return nil, err
	}
	return &c, nil
}

func (r *DMRepository) FindConversation(id string) (*domain.DMConversation, error) {
	var c domain.DMConversation
	if err := r.db.First(&c, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrConversationNotFound
		}
		return nil, err
	}
	return &c, nil
}

// List returns a page of a conversation, oldest-first for rendering.
//
// Same shape as the channel read, including spelling out `deleted_at IS NULL`:
// this query names its table as a string to join the author, and Table() opts
// out of the soft-delete scope silently — the omission that once left withdrawn
// comments on screen.
func (r *DMRepository) List(conversationID string, before time.Time, limit int) ([]domain.DMMessageResponse, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := r.db.Table("dm_messages m").
		Select(`m.id, m.conversation_id, m.author_user_id,
			COALESCE(u.username,'') AS author_name,
			m.body, m.created_at, m.updated_at`).
		Joins("LEFT JOIN users u ON u.id = m.author_user_id").
		Where("m.conversation_id = ? AND m.deleted_at IS NULL", conversationID)
	if !before.IsZero() {
		q = q.Where("m.created_at < ?", before)
	}

	out := []domain.DMMessageResponse{}
	if err := q.Order("m.created_at DESC").Limit(limit).Scan(&out).Error; err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// Nombre de quien escribe, para que el aviso diga de quién es.
//
// El título era «New direct message» a secas: con tres conversaciones abiertas,
// tres filas idénticas y ninguna forma de saber a cuál entrar. El nombre no es
// contenido —quién te escribe se ve igual en la lista de conversaciones— así
// que ponerlo no toca la decisión de dejar el cuerpo fuera.
func (r *DMRepository) NombreDe(userID string) string {
	var nombre string
	r.db.Raw(`SELECT COALESCE(username, '') FROM users WHERE id = ?`, userID).Scan(&nombre)
	return nombre
}

func (r *DMRepository) Create(m *domain.DMMessage) error { return r.db.Create(m).Error }

func (r *DMRepository) Find(id string) (*domain.DMMessage, error) {
	var m domain.DMMessage
	if err := r.db.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrDMMessageNotFound
		}
		return nil, err
	}
	return &m, nil
}

func (r *DMRepository) UpdateBody(id, body string) error {
	return r.db.Model(&domain.DMMessage{}).Where("id = ?", id).Update("body", body).Error
}

func (r *DMRepository) Withdraw(id string) error {
	return r.db.Delete(&domain.DMMessage{}, "id = ?", id).Error
}

func (r *DMRepository) MarkRead(conversationID, userID string) error {
	return r.db.Exec(`
		INSERT INTO dm_reads (conversation_id, user_id, last_read_at)
		VALUES (?, ?, now())
		ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()`,
		conversationID, userID).Error
}

// Conversations lists somebody's threads with their unread counts, in one query
// rather than one per thread.
//
// Scoped by the pair columns, which is what makes this safe: a conversation
// somebody is not part of cannot appear here at all, whatever their role.
func (r *DMRepository) Conversations(userID string, orgIDs []string) ([]domain.DMSummary, error) {
	out := []domain.DMSummary{}
	if userID == "" || len(orgIDs) == 0 {
		return out, nil
	}
	err := r.db.Raw(`
		SELECT c.id AS conversation_id, c.org_id,
		       CASE WHEN c.user_lo_id = ? THEN c.user_hi_id ELSE c.user_lo_id END AS user_id,
		       COALESCE(u.username,'') AS username, u.last_seen_at,
		       COALESCE(SUM(CASE
		            WHEN m.id IS NOT NULL
		             AND m.author_user_id <> ?
		             AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
		            THEN 1 ELSE 0 END), 0) AS unread,
		       MAX(m.created_at) AS last_message_at
		FROM dm_conversations c
		LEFT JOIN dm_messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
		LEFT JOIN dm_reads r ON r.conversation_id = c.id AND r.user_id = ?
		LEFT JOIN users u ON u.id = CASE WHEN c.user_lo_id = ? THEN c.user_hi_id ELSE c.user_lo_id END
		WHERE (c.user_lo_id = ? OR c.user_hi_id = ?) AND c.org_id IN ?
		GROUP BY c.id, c.org_id, u.username, u.last_seen_at
		ORDER BY MAX(m.created_at) DESC NULLS LAST
	`, userID, userID, userID, userID, userID, userID, orgIDs).Scan(&out).Error
	return out, err
}
