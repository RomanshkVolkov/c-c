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
	// ErrCallInviteFull: el enlace ya dejó entrar a todos los que podía, o la
	// sala de espera está llena.
	ErrCallInviteFull = errors.New("this invite has no room for more guests")
	// ErrGuestNotWaiting: se decidió sobre alguien que ya no espera — otro
	// miembro fue más rápido, o se fue.
	ErrGuestNotWaiting = errors.New("that guest is not waiting")
)

type CallInviteRepository struct{ db *gorm.DB }

func NewCallInviteRepository(db *gorm.DB) *CallInviteRepository {
	return &CallInviteRepository{db: db}
}

// DB: la conexión, para las pruebas que preparan filas de otras tablas.
func (r *CallInviteRepository) DB() *gorm.DB { return r.db }

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

// AddWaiting pone a alguien en la sala de espera, **si cabe**.
//
// La cuenta y la inserción van en la misma transacción y con la invitación
// bloqueada: veinte peticiones a la vez contarían todas diecinueve.
func (r *CallInviteRepository) AddWaiting(inv *domain.CallInvite, g *domain.CallGuest) error {
	g.Status = domain.GuestWaiting
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := lockInvite(tx, inv.ID); err != nil {
			return err
		}
		var n int64
		if err := tx.Model(&domain.CallGuest{}).
			Where("invite_id = ? AND status = ?", inv.ID, domain.GuestWaiting).
			Count(&n).Error; err != nil {
			return err
		}
		if n >= domain.MaxWaitingGuests {
			return ErrCallInviteFull
		}
		return tx.Create(g).Error
	})
}

// Admit deja entrar a quien espera, **si cabe**.
//
// El cupo (`MaxGuests`) se cuenta aquí, sobre los admitidos, y no al pedir
// entrar: si contara las peticiones, cualquiera con el enlace podría agotarlo
// sin que nadie le dejara pasar.
func (r *CallInviteRepository) Admit(inv *domain.CallInvite, guestID, by string, now time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := lockInvite(tx, inv.ID); err != nil {
			return err
		}
		if inv.MaxGuests > 0 {
			var n int64
			if err := tx.Model(&domain.CallGuest{}).
				Where("invite_id = ? AND status = ?", inv.ID, domain.GuestAdmitted).
				Count(&n).Error; err != nil {
				return err
			}
			if int(n) >= inv.MaxGuests {
				return ErrCallInviteFull
			}
		}
		return decide(tx, inv.ID, guestID, domain.GuestAdmitted, by, now)
	})
}

// Reject le dice que no a quien espera.
func (r *CallInviteRepository) Reject(inviteID, guestID, by string, now time.Time) error {
	return decide(r.db, inviteID, guestID, domain.GuestRejected, by, now)
}

// decide sólo mueve a quien **sigue esperando**: dos miembros pulsando a la vez
// —uno «dejar entrar», otro «rechazar»— no se pisan; gana el primero.
func decide(tx *gorm.DB, inviteID, guestID string, to domain.GuestStatus, by string, now time.Time) error {
	res := tx.Model(&domain.CallGuest{}).
		Where("id = ? AND invite_id = ? AND status = ?", guestID, inviteID, domain.GuestWaiting).
		Updates(map[string]any{"status": to, "decided_by": by, "decided_at": now})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrGuestNotWaiting
	}
	return nil
}

func lockInvite(tx *gorm.DB, id string) error {
	var locked domain.CallInvite
	return tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&locked, "id = ?", id).Error
}

// Waiting: quién espera en una reunión, el primero que llegó primero.
func (r *CallInviteRepository) Waiting(inviteID string) ([]domain.CallGuest, error) {
	var out []domain.CallGuest
	err := r.db.Where("invite_id = ? AND status = ?", inviteID, domain.GuestWaiting).
		Order("created_at ASC").Find(&out).Error
	return out, err
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

// KickGuest marca a un invitado como echado, y su entrada como rechazada: con
// su pase no vuelve ni a la sala ni a la de espera. La primera vez cuenta; las
// siguientes no cambian quién lo hizo ni cuándo.
func (r *CallInviteRepository) KickGuest(inviteID, guestID, by string, now time.Time) error {
	return r.db.Model(&domain.CallGuest{}).
		Where("id = ? AND invite_id = ? AND kicked_at IS NULL", guestID, inviteID).
		Updates(map[string]any{"kicked_at": now, "kicked_by": by, "status": domain.GuestRejected}).Error
}

// IsMember: si una persona es de la organización. Para el timbre: sólo se
// llama a gente de dentro.
func (r *CallInviteRepository) IsMember(orgID, userID string) bool {
	var n int64
	r.db.Table("org_memberships").Where("org_id = ? AND user_id = ?", orgID, userID).Count(&n)
	return n > 0
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
