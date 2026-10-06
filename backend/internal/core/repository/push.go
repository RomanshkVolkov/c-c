package repository

import (
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PushRepository: los dispositivos que pidieron avisos. Ver domain/push.go.
type PushRepository struct{ db *gorm.DB }

func NewPushRepository(db *gorm.DB) *PushRepository { return &PushRepository{db: db} }

// Upsert guarda un dispositivo. El mismo `Endpoint` es el mismo navegador: si
// vuelve a suscribirse se le actualizan las llaves **y el dueño**, porque en un
// navegador compartido el que se suscribe último es quien recibe. Si no, los
// avisos de Ana seguirían llegando al portátil que ahora usa Bea.
func (r *PushRepository) Upsert(s *domain.PushSubscription) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "endpoint"}},
		DoUpdates: clause.AssignmentColumns([]string{"user_id", "p256dh", "auth", "user_agent", "updated_at"}),
	}).Create(s).Error
}

// ForUser: los dispositivos de una persona.
func (r *PushRepository) ForUser(userID string) ([]domain.PushSubscription, error) {
	var out []domain.PushSubscription
	err := r.db.Where("user_id = ?", userID).Find(&out).Error
	return out, err
}

// Delete quita un dispositivo, sólo si es de esa persona: un endpoint ajeno no
// se puede dar de baja por conocerlo.
func (r *PushRepository) Delete(userID, endpoint string) error {
	return r.db.Where("user_id = ? AND endpoint = ?", userID, endpoint).Delete(&domain.PushSubscription{}).Error
}

// Forget quita un dispositivo que el servicio de push dio por muerto (404 o
// 410). Sin dueño: ese endpoint ya no existe para nadie.
func (r *PushRepository) Forget(endpoint string) error {
	return r.db.Where("endpoint = ?", endpoint).Delete(&domain.PushSubscription{}).Error
}

// MarkOk apunta que el servicio de push aceptó un aviso para ese dispositivo.
func (r *PushRepository) MarkOk(id string, now time.Time) error {
	return r.db.Model(&domain.PushSubscription{}).Where("id = ?", id).Update("last_ok_at", now).Error
}
