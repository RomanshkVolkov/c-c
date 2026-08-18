package repository

import (
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

type NotificationRepository struct{ db *gorm.DB }

func NewNotificationRepository(db *gorm.DB) *NotificationRepository {
	return &NotificationRepository{db: db}
}

// Add records one notification. Failures are the caller's to swallow: not being
// told about a message is bad, but failing to send the message because the
// telling failed is worse.
func (r *NotificationRepository) Add(n *domain.Notification) error {
	return r.db.Create(n).Error
}

// Feed is one person's inbox for one organization, newest first.
//
// Unread is counted separately rather than derived from the page, or the badge
// would say "20" forever once there were more than a page of them.
func (r *NotificationRepository) Feed(userID, orgID string, limit int) (domain.NotificationFeed, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := r.db.Model(&domain.Notification{}).Where("user_id = ?", userID)
	if orgID != "" {
		q = q.Where("org_id = ?", orgID)
	}

	var out domain.NotificationFeed
	out.Items = []domain.Notification{}
	if err := q.Session(&gorm.Session{}).
		Order("created_at DESC").Limit(limit).Find(&out.Items).Error; err != nil {
		return out, err
	}
	if err := q.Session(&gorm.Session{}).
		Where("read_at IS NULL").Count(&out.Unread).Error; err != nil {
		return out, err
	}
	return out, nil
}

// MarkRead is scoped to the caller: ids alone would let anybody mark somebody
// else's inbox, which is a small thing to be able to do to another person and
// no reason to allow.
func (r *NotificationRepository) MarkRead(userID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	now := time.Now()
	return r.db.Model(&domain.Notification{}).
		Where("user_id = ? AND id IN ? AND read_at IS NULL", userID, ids).
		Update("read_at", now).Error
}

func (r *NotificationRepository) MarkAllRead(userID, orgID string) error {
	now := time.Now()
	q := r.db.Model(&domain.Notification{}).Where("user_id = ? AND read_at IS NULL", userID)
	if orgID != "" {
		q = q.Where("org_id = ?", orgID)
	}
	return q.Update("read_at", now).Error
}
