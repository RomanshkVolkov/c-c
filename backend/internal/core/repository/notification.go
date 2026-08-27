package repository

import (
	"errors"
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

	// Las filas escritas antes de que existiera la columna no traen clave. Se
	// deduce **al leer**, no con un backfill: así no hace falta migrar datos ni
	// escribir SQL de un motor concreto, y la columna guardada sigue siendo la
	// verdad — el día que un enlace cambie de forma, la deducción se rompe y lo
	// almacenado no.
	//
	// Aquí y no en la app para que exista **una sola** gramática de claves. Con
	// una copia en el cliente, el día que discreparan, las filas viejas y las
	// nuevas del mismo canal formarían dos grupos.
	for i := range out.Items {
		if out.Items[i].GroupKey == "" {
			out.Items[i].GroupKey = domain.DeriveGroup(out.Items[i].Kind, out.Items[i].Link)
		}
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

// Prefs reads somebody's preferences, or the defaults if they never set any.
//
// The absent row is not an error and not "everything off": nobody opts in to
// being told they were named.
func (r *NotificationRepository) Prefs(userID string) (domain.NotificationPrefs, error) {
	var p domain.NotificationPrefs
	err := r.db.Where("user_id = ?", userID).First(&p).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return domain.DefaultPrefs(userID), nil
		}
		return domain.DefaultPrefs(userID), err
	}
	return p, nil
}

func (r *NotificationRepository) SavePrefs(p domain.NotificationPrefs) error {
	return r.db.Save(&p).Error
}
