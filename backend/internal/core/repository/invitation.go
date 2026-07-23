package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var (
	ErrInvitationNotFound = errors.New("invitation not found")
	ErrInvitationExists   = errors.New("a pending invitation already exists for this user")
	ErrAlreadyMember      = errors.New("user is already a member of this organization")
)

type InvitationRepository struct {
	db *gorm.DB
}

func NewInvitationRepository(db *gorm.DB) *InvitationRepository {
	return &InvitationRepository{db: db}
}

// Create inserts a pending invitation after guarding against an existing pending
// invite and against the target already being a member.
func (r *InvitationRepository) Create(inv *domain.OrgInvitation) error {
	var users int64
	if err := r.db.Model(&domain.User{}).Where("id = ?", inv.InvitedUserID).Count(&users).Error; err != nil {
		return err
	}
	if users == 0 {
		return ErrUserNotFound
	}
	var members int64
	if err := r.db.Model(&domain.OrgMembership{}).
		Where("org_id = ? AND user_id = ?", inv.OrgID, inv.InvitedUserID).
		Count(&members).Error; err != nil {
		return err
	}
	if members > 0 {
		return ErrAlreadyMember
	}
	var pending int64
	if err := r.db.Model(&domain.OrgInvitation{}).
		Where("org_id = ? AND invited_user_id = ? AND status = ?", inv.OrgID, inv.InvitedUserID, domain.InvitePending).
		Count(&pending).Error; err != nil {
		return err
	}
	if pending > 0 {
		return ErrInvitationExists
	}
	return r.db.Create(inv).Error
}

func (r *InvitationRepository) FindByID(id string) (*domain.OrgInvitation, error) {
	var inv domain.OrgInvitation
	if err := r.db.First(&inv, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrInvitationNotFound
		}
		return nil, err
	}
	return &inv, nil
}

// ListForUser returns the invitee's pending invitations, with org name and
// inviter username so the app can render an actionable list.
func (r *InvitationRepository) ListForUser(userID string) ([]domain.InvitationResponse, error) {
	var out []domain.InvitationResponse
	err := r.db.Raw(`
		SELECT i.id, i.org_id, o.name AS org_name, i.role, i.status,
		       inv.username AS invited_by, i.created_at
		FROM org_invitations i
		JOIN organizations o ON o.id = i.org_id
		LEFT JOIN users inv ON inv.id = i.invited_by_user_id
		WHERE i.invited_user_id = ? AND i.status = ?
		ORDER BY i.created_at DESC
	`, userID, domain.InvitePending).Scan(&out).Error
	return out, err
}

// ListForOrg returns an org's pending invitations, with the invitee's username
// (admin management view).
func (r *InvitationRepository) ListForOrg(orgID string) ([]domain.InvitationResponse, error) {
	var out []domain.InvitationResponse
	err := r.db.Raw(`
		SELECT i.id, i.org_id, o.name AS org_name, i.role, i.status,
		       inv.username AS invited_by, u.username AS invited_user, i.created_at
		FROM org_invitations i
		JOIN organizations o ON o.id = i.org_id
		LEFT JOIN users inv ON inv.id = i.invited_by_user_id
		LEFT JOIN users u ON u.id = i.invited_user_id
		WHERE i.org_id = ? AND i.status = ?
		ORDER BY i.created_at DESC
	`, orgID, domain.InvitePending).Scan(&out).Error
	return out, err
}

// Accept marks a pending invitation accepted and creates the membership in one
// transaction. It re-checks the pending status inside the tx to avoid a double
// accept race.
func (r *InvitationRepository) Accept(inv *domain.OrgInvitation) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&domain.OrgInvitation{}).
			Where("id = ? AND status = ?", inv.ID, domain.InvitePending).
			Update("status", domain.InviteAccepted)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrInvitationNotFound // already accepted/declined/revoked
		}
		// Upsert the membership (idempotent if one somehow exists).
		var existing domain.OrgMembership
		err := tx.Where("org_id = ? AND user_id = ?", inv.OrgID, inv.InvitedUserID).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return tx.Create(&domain.OrgMembership{
				OrgID:  inv.OrgID,
				UserID: inv.InvitedUserID,
				Role:   inv.Role,
			}).Error
		}
		if err != nil {
			return err
		}
		return nil
	})
}

// SetStatus transitions a pending invitation to declined/revoked.
func (r *InvitationRepository) SetStatus(id string, status domain.InvitationStatus) error {
	res := r.db.Model(&domain.OrgInvitation{}).
		Where("id = ? AND status = ?", id, domain.InvitePending).
		Update("status", status)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrInvitationNotFound
	}
	return nil
}
