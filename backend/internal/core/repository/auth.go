package repository

import (
	"errors"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var ErrUsernameTaken = errors.New("username already in use")

type AuthRepository struct {
	db *gorm.DB
}

func NewAuthRepository(db *gorm.DB) *AuthRepository {
	return &AuthRepository{db: db}
}

// CreateUser inserts a new user, rejecting a duplicate username.
func (r *AuthRepository) CreateUser(u *domain.User) error {
	var count int64
	if err := r.db.Model(&domain.User{}).Where("username = ?", u.Username).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrUsernameTaken
	}
	return r.db.Create(u).Error
}

// ListUsers returns all users ordered by username (superadmin console).
func (r *AuthRepository) ListUsers() ([]domain.User, error) {
	var users []domain.User
	err := r.db.Order("username ASC").Find(&users).Error
	return users, err
}

// UpdateUser applies a set of column updates to a user by id.
func (r *AuthRepository) UpdateUser(id string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	res := r.db.Model(&domain.User{}).Where("id = ?", id).Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return errors.New("user not found")
	}
	return nil
}

// DeleteUser removes a user and all of their org memberships in one tx.
func (r *AuthRepository) DeleteUser(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", id).Delete(&domain.OrgMembership{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.User{}, "id = ?", id).Error
	})
}

func (r *AuthRepository) FindByUsername(username string) (*domain.User, error) {
	var user domain.User
	if err := r.db.Where("username = ?", username).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errors.New("user not found")
		}
		return nil, err
	}
	return &user, nil
}

// OrgClaimsForUser returns the compact org memberships embedded in the access
// token so scoping middleware can decide access without a DB round-trip.
func (r *AuthRepository) OrgClaimsForUser(userID string) ([]domain.OrgMembershipClaim, error) {
	var claims []domain.OrgMembershipClaim
	err := r.db.
		Model(&domain.OrgMembership{}).
		Select("org_id", "role").
		Where("user_id = ?", userID).
		Scan(&claims).Error
	if err != nil {
		return nil, err
	}
	return claims, nil
}

func (r *AuthRepository) FindByID(id string) (*domain.User, error) {
	var user domain.User
	if err := r.db.First(&user, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errors.New("user not found")
		}
		return nil, err
	}
	return &user, nil
}

// SearchByUsername returns up to `limit` users whose username matches the query
// (case-insensitive prefix). The caller (`excludeID`) is filtered out so users
// don't see themselves in share autocomplete.
func (r *AuthRepository) SearchByUsername(query, excludeID string, limit int) ([]domain.User, error) {
	if limit <= 0 {
		limit = 10
	}
	var users []domain.User
	q := r.db.
		Where("LOWER(username) LIKE ?", "%"+strings.ToLower(query)+"%").
		Order("username ASC").
		Limit(limit)
	if excludeID != "" {
		q = q.Where("id <> ?", excludeID)
	}
	if err := q.Find(&users).Error; err != nil {
		return nil, err
	}
	return users, nil
}
