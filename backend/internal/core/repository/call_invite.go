package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var (
	ErrCallInviteNotFound = errors.New("call invite not found")
	ErrCallGuestNotFound  = errors.New("call guest not found")
	// ErrCallInviteFull: el enlace ya dejó entrar a todos los que podía.
	ErrCallInviteFull = errors.New("this invite has no room for more guests")
)

type CallInviteRepository struct{ db *gorm.DB }

func NewCallInviteRepository(db *gorm.DB) *CallInviteRepository {
	return &CallInviteRepository{db: db}
}

func (r *CallInviteRepository) Create(inv *domain.CallInvite) error {
	return r.db.Create(inv).Error
}

func (r *CallInviteRepository) FindByID(id string) (*domain.CallInvite, error) {
	var inv domain.CallInvite
	if err := r.db.First(&inv, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCallInviteNotFound
		}
		return nil, err
	}
	return &inv, nil
}

// ListLive: las invitaciones que todavía abren algo, la más nueva primero.
//
// Las muertas no salen: la lista es para copiar un enlace o entrar, y uno que
// ya no abre nada sólo estorba. Con `spaceID` vacío salen las de toda la
// organización.
func (r *CallInviteRepository) ListLive(orgID, spaceID string, now time.Time) ([]domain.CallInvite, error) {
	q := r.db.Where("org_id = ? AND revoked_at IS NULL AND expires_at > ?", orgID, now)
	if spaceID != "" {
		q = q.Where("space_id = ?", spaceID)
	}
	var out []domain.CallInvite
	err := q.Order("created_at DESC").Find(&out).Error
	return out, err
}

// Revoke cierra el enlace. Idempotente: revocar dos veces deja la primera fecha.
func (r *CallInviteRepository) Revoke(id string, now time.Time) error {
	return r.db.Model(&domain.CallInvite{}).
		Where("id = ? AND revoked_at IS NULL", id).
		Update("revoked_at", now).Error
}

// AddGuest apunta a alguien de fuera que entra, **si cabe**.
//
// La cuenta y la inserción van en la misma transacción y con la invitación
// bloqueada: dos personas pulsando «entrar» a la vez con un enlace para una
// contarían las dos cero y entrarían las dos.
func (r *CallInviteRepository) AddGuest(inv *domain.CallInvite, g *domain.CallGuest) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if inv.MaxGuests > 0 {
			var locked domain.CallInvite
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				First(&locked, "id = ?", inv.ID).Error; err != nil {
				return err
			}
			var n int64
			if err := tx.Model(&domain.CallGuest{}).Where("invite_id = ?", inv.ID).
				Count(&n).Error; err != nil {
				return err
			}
			if int(n) >= inv.MaxGuests {
				return ErrCallInviteFull
			}
		}
		return tx.Create(g).Error
	})
}

func (r *CallInviteRepository) FindGuest(inviteID, guestID string) (*domain.CallGuest, error) {
	var g domain.CallGuest
	if err := r.db.First(&g, "id = ? AND invite_id = ?", guestID, inviteID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCallGuestNotFound
		}
		return nil, err
	}
	return &g, nil
}

func (r *CallInviteRepository) TouchGuest(id string, now time.Time) error {
	return r.db.Model(&domain.CallGuest{}).Where("id = ?", id).
		Update("last_join_at", now).Error
}

// KickGuest marca a un invitado como echado. La primera vez cuenta; las
// siguientes no cambian quién lo hizo ni cuándo.
func (r *CallInviteRepository) KickGuest(inviteID, guestID, by string, now time.Time) error {
	return r.db.Model(&domain.CallGuest{}).
		Where("id = ? AND invite_id = ? AND kicked_at IS NULL", guestID, inviteID).
		Updates(map[string]any{"kicked_at": now, "kicked_by": by}).Error
}

// OrgName: cómo se llama la organización, para la página del invitado.
func (r *CallInviteRepository) OrgName(orgID string) (string, error) {
	var name string
	err := r.db.Table("organizations").Select("name").Where("id = ?", orgID).Scan(&name).Error
	return name, err
}

// SpaceName: cómo se llama el canal del que cuelga una invitación.
func (r *CallInviteRepository) SpaceName(spaceID string) (string, error) {
	var name string
	err := r.db.Table("task_spaces").Select("name").Where("id = ?", spaceID).Scan(&name).Error
	return name, err
}

// DisplayName: cómo se llama una persona. Por `nombreVisible`, como todo lo
// que se pinta (`TestNadieResuelveElNombreASuAire`).
func (r *CallInviteRepository) DisplayName(userID string) (string, error) {
	var name string
	err := r.db.Table("users").Select(nombreVisible+" as name").
		Where("id = ?", userID).Scan(&name).Error
	return name, err
}
