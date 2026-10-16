package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Las sesiones de llamada. Ver domain/call_session.go.

var ErrCallSessionNotFound = errors.New("call session not found")

type CallSessionRepository struct{ db *gorm.DB }

func NewCallSessionRepository(db *gorm.DB) *CallSessionRepository {
	return &CallSessionRepository{db: db}
}

// Open abre la sesión de la sala si no tiene una abierta, y devuelve la
// abierta en cualquier caso.
//
// **Sin leer antes de escribir.** Mirar si hay una y crearla si no es una
// carrera entre dos entradas a la vez —dos réplicas, o dos personas pulsando
// «Unirse» juntas— y saldrían dos llamadas de una. El índice único parcial
// `(room) WHERE ended_at IS NULL` decide: la segunda inserción choca y no
// hace nada, y las dos leen la misma.
func (r *CallSessionRepository) Open(s *domain.CallSession) (*domain.CallSession, error) {
	if err := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(s).Error; err != nil {
		return nil, err
	}
	var open domain.CallSession
	if err := r.db.Where("room = ? AND ended_at IS NULL", s.Room).First(&open).Error; err != nil {
		return nil, err
	}
	return &open, nil
}

// El chat de la llamada (domain/call_message.go).

var ErrCallMessageNotFound = errors.New("call message not found")

func (r *CallSessionRepository) CreateMessage(m *domain.CallMessage) error {
	return r.db.Create(m).Error
}

// Messages: el chat entero de una llamada, en orden. Sin paginar: dura lo
// que dura una llamada, no lo que dura un canal.
func (r *CallSessionRepository) Messages(sessionID string) ([]domain.CallMessage, error) {
	out := []domain.CallMessage{}
	err := r.db.Where("session_id = ?", sessionID).Order("created_at ASC").Limit(2000).Find(&out).Error
	return out, err
}

func (r *CallSessionRepository) CountMessages(sessionID string) (int64, error) {
	var n int64
	err := r.db.Model(&domain.CallMessage{}).Where("session_id = ?", sessionID).Count(&n).Error
	return n, err
}

func (r *CallSessionRepository) FindMessage(id string) (*domain.CallMessage, error) {
	var m domain.CallMessage
	if err := r.db.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCallMessageNotFound
		}
		return nil, err
	}
	return &m, nil
}

// DisplayName: cómo se llama a quien escribe (ver `nombreVisible`).
func (r *CallSessionRepository) DisplayName(userID string) string {
	var name string
	r.db.Table("users").Select(nombreVisible).Where("id = ?", userID).Scan(&name)
	return name
}

func (r *CallSessionRepository) UpdateMessage(id, body string) error {
	return r.db.Model(&domain.CallMessage{}).Where("id = ?", id).Update("body", body).Error
}

func (r *CallSessionRepository) WithdrawMessage(id string) error {
	return r.db.Delete(&domain.CallMessage{}, "id = ?", id).Error
}

func (r *CallSessionRepository) FindByID(id string) (*domain.CallSession, error) {
	var s domain.CallSession
	if err := r.db.First(&s, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCallSessionNotFound
		}
		return nil, err
	}
	return &s, nil
}

// Unfinished: las abiertas, para el reloj.
func (r *CallSessionRepository) Unfinished() ([]domain.CallSession, error) {
	var out []domain.CallSession
	err := r.db.Where("ended_at IS NULL").Order("started_at ASC").Find(&out).Error
	return out, err
}

// ClaimTick: el testigo del reparto entre réplicas, como en Recording.
func (r *CallSessionRepository) ClaimTick(id string, seen, now time.Time) (bool, error) {
	res := r.db.Model(&domain.CallSession{}).
		Where("id = ? AND ticked_at = ?", id, seen).
		Update("ticked_at", now)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// Seen: el reloj vio gente dentro. Pone a cero la cuenta de vacíos, apunta la
// hora y a quien no estaba apuntado.
func (r *CallSessionRepository) Seen(id string, now time.Time, people []domain.CallSessionParticipant) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&domain.CallSession{}).Where("id = ?", id).
			Updates(map[string]any{"last_seen_at": now, "empty_ticks": 0}).Error; err != nil {
			return err
		}
		if len(people) == 0 {
			return nil
		}
		// Quien ya estaba apuntado se queda con su primera hora.
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&people).Error
	})
}

func (r *CallSessionRepository) SetEmptyTicks(id string, n int) error {
	return r.db.Model(&domain.CallSession{}).Where("id = ?", id).Update("empty_ticks", n).Error
}

// Close cierra la sesión **exactamente una vez**: el UPDATE condicional sólo
// deja pasar al primero, y sólo ése resume. Dos réplicas cerrando a la vez
// pondrían dos líneas en el canal.
func (r *CallSessionRepository) Close(id string, endedAt time.Time) (bool, error) {
	res := r.db.Model(&domain.CallSession{}).
		Where("id = ? AND ended_at IS NULL", id).
		Update("ended_at", endedAt)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

func (r *CallSessionRepository) Participants(id string) ([]domain.CallSessionParticipant, error) {
	out := []domain.CallSessionParticipant{}
	err := r.db.Where("session_id = ?", id).Order("first_joined_at ASC").Find(&out).Error
	return out, err
}

func (r *CallSessionRepository) SetSummary(id, messageID string) error {
	return r.db.Model(&domain.CallSession{}).Where("id = ?", id).Update("summary_message_id", messageID).Error
}

// LinkRecording: la grabación es de la llamada que estaba en esa sala cuando
// empezó a grabarse. La más reciente que empezó antes, abierta o no: la
// grabación puede quedar lista cuando la llamada ya terminó.
func (r *CallSessionRepository) LinkRecording(room string, startedAt time.Time, recordingID string) (*domain.CallSession, error) {
	var s domain.CallSession
	err := r.db.Where("room = ? AND started_at <= ?", room, startedAt).
		Order("started_at DESC").First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := r.db.Model(&domain.CallSession{}).Where("id = ?", s.ID).
		Update("recording_id", recordingID).Error; err != nil {
		return nil, err
	}
	s.RecordingID = &recordingID
	return &s, nil
}
