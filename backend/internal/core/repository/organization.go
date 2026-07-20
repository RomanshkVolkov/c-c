package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var (
	ErrOrgNotFound        = errors.New("organization not found")
	ErrOrgSlugTaken       = errors.New("organization slug already in use")
	ErrOrgHasServers      = errors.New("organization still has servers")
	ErrMembershipNotFound = errors.New("membership not found")
	ErrUserNotFound       = errors.New("user not found")
)

type OrganizationRepository struct {
	db *gorm.DB
}

func NewOrganizationRepository(db *gorm.DB) *OrganizationRepository {
	return &OrganizationRepository{db: db}
}

// CreateWithOwner creates the organization and makes the creator its admin in a
// single transaction.
func (r *OrganizationRepository) CreateWithOwner(org *domain.Organization, ownerID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&domain.Organization{}).Where("slug = ?", org.Slug).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrOrgSlugTaken
		}
		if err := tx.Create(org).Error; err != nil {
			return err
		}
		return tx.Create(&domain.OrgMembership{
			OrgID:  org.ID,
			UserID: ownerID,
			Role:   domain.OrgRoleAdmin,
		}).Error
	})
}

func (r *OrganizationRepository) FindByID(id string) (*domain.Organization, error) {
	var org domain.Organization
	if err := r.db.First(&org, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrOrgNotFound
		}
		return nil, err
	}
	return &org, nil
}

func (r *OrganizationRepository) Update(org *domain.Organization) error {
	return r.db.Model(&domain.Organization{}).
		Where("id = ?", org.ID).
		Update("name", org.Name).Error
}

// Delete removes the organization and its memberships. It refuses to delete an
// org that still owns servers so those never become orphaned/inaccessible.
func (r *OrganizationRepository) Delete(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var servers int64
		if err := tx.Model(&domain.Server{}).Where("org_id = ?", id).Count(&servers).Error; err != nil {
			return err
		}
		if servers > 0 {
			return ErrOrgHasServers
		}
		if err := tx.Where("org_id = ?", id).Delete(&domain.OrgMembership{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.Organization{}, "id = ?", id).Error
	})
}

// ListForUser returns the organizations the user belongs to, each carrying the
// user's role, so the app can render the org switcher in one round-trip.
func (r *OrganizationRepository) ListForUser(userID string) ([]domain.OrganizationResponse, error) {
	var out []domain.OrganizationResponse
	err := r.db.Raw(`
		SELECT o.id, o.name, o.slug, m.role
		FROM organizations o
		JOIN org_memberships m ON m.org_id = o.id
		WHERE m.user_id = ?
		ORDER BY o.name ASC
	`, userID).Scan(&out).Error
	return out, err
}

// GetMembership returns the caller's membership in an org, or ErrMembershipNotFound.
func (r *OrganizationRepository) GetMembership(orgID, userID string) (*domain.OrgMembership, error) {
	var m domain.OrgMembership
	err := r.db.Where("org_id = ? AND user_id = ?", orgID, userID).First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrMembershipNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (r *OrganizationRepository) ListMembers(orgID string) ([]domain.MemberResponse, error) {
	var out []domain.MemberResponse
	err := r.db.Raw(`
		SELECT m.user_id, u.username, m.role
		FROM org_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.org_id = ?
		ORDER BY u.username ASC
	`, orgID).Scan(&out).Error
	return out, err
}

// UpsertMember adds or updates a membership. Returns ErrUserNotFound if the
// target user does not exist.
func (r *OrganizationRepository) UpsertMember(orgID, userID string, role domain.OrgRole) error {
	var users int64
	if err := r.db.Model(&domain.User{}).Where("id = ?", userID).Count(&users).Error; err != nil {
		return err
	}
	if users == 0 {
		return ErrUserNotFound
	}
	var existing domain.OrgMembership
	err := r.db.Where("org_id = ? AND user_id = ?", orgID, userID).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return r.db.Create(&domain.OrgMembership{OrgID: orgID, UserID: userID, Role: role}).Error
	}
	if err != nil {
		return err
	}
	return r.db.Model(&domain.OrgMembership{}).
		Where("org_id = ? AND user_id = ?", orgID, userID).
		Update("role", role).Error
}

func (r *OrganizationRepository) UpdateMemberRole(orgID, userID string, role domain.OrgRole) error {
	res := r.db.Model(&domain.OrgMembership{}).
		Where("org_id = ? AND user_id = ?", orgID, userID).
		Update("role", role)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrMembershipNotFound
	}
	return nil
}

func (r *OrganizationRepository) RemoveMember(orgID, userID string) error {
	res := r.db.Where("org_id = ? AND user_id = ?", orgID, userID).Delete(&domain.OrgMembership{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrMembershipNotFound
	}
	return nil
}

// CountAdmins returns how many admins an org has (used to block removing the
// last admin).
func (r *OrganizationRepository) CountAdmins(orgID string) (int64, error) {
	var n int64
	err := r.db.Model(&domain.OrgMembership{}).
		Where("org_id = ? AND role = ?", orgID, domain.OrgRoleAdmin).
		Count(&n).Error
	return n, err
}
