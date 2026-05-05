package repository

import (
	"errors"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

type AuthRepository struct {
	db *gorm.DB
}

func NewAuthRepository(db *gorm.DB) *AuthRepository {
	return &AuthRepository{db: db}
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
