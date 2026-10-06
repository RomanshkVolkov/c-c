package repository

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PushRepository: los dispositivos que pidieron avisos. Ver domain/push.go.
type PushRepository struct{ db *gorm.DB }

func NewPushRepository(db *gorm.DB) *PushRepository { return &PushRepository{db: db} }

// Upsert guarda un dispositivo. El mismo `Endpoint` es el mismo navegador: si
// la misma persona vuelve a suscribirse, se le actualizan las llaves.
//
// **Nunca cambia de dueño.** Si el endpoint es de otra persona, contesta
// ErrPushNotYours: si no, cualquiera que supiera el endpoint de otro se lo
// quedaría y esa persona dejaría de recibir sus avisos. En un navegador
// compartido, salir da de baja la suscripción (`disablePush`), y si alguien no
// salió, la web rehace la suscripción —endpoint nuevo— al recibir este error.
func (r *PushRepository) Upsert(s *domain.PushSubscription) error {
	var prev domain.PushSubscription
	err := r.db.Where("endpoint = ?", s.Endpoint).Take(&prev).Error
	if err == nil && prev.UserID != s.UserID {
		return ErrPushNotYours
	}
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "endpoint"}},
		DoUpdates: clause.AssignmentColumns([]string{"p256dh", "auth", "user_agent", "updated_at"}),
	}).Create(s).Error
}

// ErrPushNotYours: ese endpoint ya es de otra persona con esas mismas llaves.
var ErrPushNotYours = errors.New("push-not-yours")

// CountForUser: cuántos dispositivos tiene suscritos una persona.
func (r *PushRepository) CountForUser(userID string) (int64, error) {
	var n int64
	err := r.db.Model(&domain.PushSubscription{}).Where("user_id = ?", userID).Count(&n).Error
	return n, err
}

// Has: si ese endpoint ya es de esa persona (volver a suscribirse no cuenta
// contra el tope).
func (r *PushRepository) Has(userID, endpoint string) bool {
	var n int64
	r.db.Model(&domain.PushSubscription{}).Where("user_id = ? AND endpoint = ?", userID, endpoint).Count(&n)
	return n > 0
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
