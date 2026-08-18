package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var (
	ErrMessageNotFound = errors.New("message not found")
	// ErrChatAttachmentNotFound: asked for a file that is not in this channel.
	ErrChatAttachmentNotFound = errors.New("attachment not found")
)

type ChatRepository struct {
	db *gorm.DB
}

func NewChatRepository(db *gorm.DB) *ChatRepository { return &ChatRepository{db: db} }

// List returns the newest messages of a channel, oldest-first for rendering.
//
// Paged backwards from `before` because a channel is read from the bottom: the
// first screen is the last N lines, and scrolling up asks for what came before
// that. An offset would renumber everything each time somebody posts.
//
// `deleted_at IS NULL` is written out rather than left to GORM's scope, because
// this query names its table as a string to join the author — and Table() opts
// out of that scope silently. That exact omission shipped this week on the item
// threads: withdrawing a comment appeared to fail, the line stayed on screen,
// and trying again answered "not found" about something plainly visible.
func (r *ChatRepository) List(spaceID string, before time.Time, limit int) ([]domain.ChatMessageResponse, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := r.db.Table("chat_messages m").
		Select(`m.id, m.space_id, m.author_user_id,
			COALESCE(u.username,'') AS author_name,
			m.body, m.created_at, m.updated_at`).
		Joins("LEFT JOIN users u ON u.id = m.author_user_id").
		Where("m.space_id = ? AND m.deleted_at IS NULL", spaceID)
	if !before.IsZero() {
		q = q.Where("m.created_at < ?", before)
	}

	out := []domain.ChatMessageResponse{}
	// Newest first for the limit, then flipped: the page we want is the tail,
	// but a channel reads top-down.
	if err := q.Order("m.created_at DESC").Limit(limit).Scan(&out).Error; err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (r *ChatRepository) Create(m *domain.ChatMessage) error { return r.db.Create(m).Error }

func (r *ChatRepository) Find(id string) (*domain.ChatMessage, error) {
	var m domain.ChatMessage
	if err := r.db.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrMessageNotFound
		}
		return nil, err
	}
	return &m, nil
}

func (r *ChatRepository) UpdateBody(id, body string) error {
	return r.db.Model(&domain.ChatMessage{}).Where("id = ?", id).Update("body", body).Error
}

// Withdraw hides a message. The row stays: what somebody wrote is not ours to
// destroy, and the read above already refuses to show it.
func (r *ChatRepository) Withdraw(id string) error {
	return r.db.Delete(&domain.ChatMessage{}, "id = ?", id).Error
}

// MarkRead moves someone's watermark in a channel to now.
func (r *ChatRepository) MarkRead(spaceID, userID string) error {
	return r.db.Exec(`
		INSERT INTO chat_reads (space_id, user_id, last_read_at)
		VALUES (?, ?, now())
		ON CONFLICT (space_id, user_id) DO UPDATE SET last_read_at = now()`,
		spaceID, userID).Error
}

// UnreadBySpace counts what each of the caller's spaces holds that they haven't
// read, in one query rather than one per space — the navigator asks for all of
// them on every load.
//
// Your own messages never count. Being told you have one unread because you just
// typed it is the same failure as being notified about your own comment, which
// this codebase spent an evening removing.
func (r *ChatRepository) UnreadBySpace(userID string, orgIDs []string, superadmin bool) ([]domain.ChatUnread, error) {
	out := []domain.ChatUnread{}
	q := r.db.Table("chat_messages m").
		Select("m.space_id, COUNT(*) AS count").
		Joins("LEFT JOIN chat_reads r ON r.space_id = m.space_id AND r.user_id = ?", userID).
		Where("m.deleted_at IS NULL").
		Where("m.author_user_id <> ?", userID).
		Where("r.last_read_at IS NULL OR m.created_at > r.last_read_at")
	if !superadmin {
		if len(orgIDs) == 0 {
			return out, nil
		}
		q = q.Where("m.org_id IN ?", orgIDs)
	}
	return out, q.Group("m.space_id").Scan(&out).Error
}

// MembersOf narrows a list of asserted user ids to the ones that actually
// belong to an organization.
//
// The ids arrive inside a message body, which is text somebody typed: nothing
// stops a caller from naming every uuid they can think of. Without this, a
// mention would be a way to ping anybody on the platform — including people at
// another client — about work they have nothing to do with.
//
// Returns them in the order asked, so the caller's list stays stable.
// Follow y Unfollow: seguir un canal es idempotente en las dos direcciones —
// pulsar dos veces «seguir» no es un error que merezca una pantalla roja.
func (r *ChatRepository) Follow(spaceID, userID string) error {
	return r.db.Where("space_id = ? AND user_id = ?", spaceID, userID).
		FirstOrCreate(&domain.SpaceFollower{SpaceID: spaceID, UserID: userID}).Error
}

func (r *ChatRepository) Unfollow(spaceID, userID string) error {
	return r.db.Where("space_id = ? AND user_id = ?", spaceID, userID).
		Delete(&domain.SpaceFollower{}).Error
}

// Followers son los ids a los que avisar de un mensaje corriente.
func (r *ChatRepository) Followers(spaceID string) ([]string, error) {
	var ids []string
	err := r.db.Model(&domain.SpaceFollower{}).
		Where("space_id = ?", spaceID).Pluck("user_id", &ids).Error
	return ids, err
}

// FollowedSpaces son los espacios que este usuario sigue, para que la pantalla
// pueda pintar el estado del botón sin una consulta por canal.
func (r *ChatRepository) FollowedSpaces(userID string) ([]string, error) {
	var ids []string
	err := r.db.Model(&domain.SpaceFollower{}).
		Where("user_id = ?", userID).Pluck("space_id", &ids).Error
	return ids, err
}

func (r *ChatRepository) MembersOf(orgID string, userIDs []string) ([]string, error) {
	if orgID == "" || len(userIDs) == 0 {
		return nil, nil
	}
	var found []string
	if err := r.db.Raw(`
		SELECT user_id FROM org_memberships
		WHERE org_id = ? AND user_id IN ?
	`, orgID, userIDs).Scan(&found).Error; err != nil {
		return nil, err
	}
	ok := make(map[string]bool, len(found))
	for _, id := range found {
		ok[id] = true
	}
	out := make([]string, 0, len(found))
	for _, id := range userIDs {
		if ok[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

// ─── Attachments ──────────────────────────────────────────────────────────────

func (r *ChatRepository) CreateAttachment(a *domain.ChatAttachment) error {
	return r.db.Create(a).Error
}

func (r *ChatRepository) FindAttachment(id string) (*domain.ChatAttachment, error) {
	var a domain.ChatAttachment
	if err := r.db.First(&a, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrChatAttachmentNotFound
		}
		return nil, err
	}
	return &a, nil
}
