package repository

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var ErrTokenNotFound = errors.New("token not found")

type TokenRepository struct {
	db *gorm.DB
}

func NewTokenRepository(db *gorm.DB) *TokenRepository {
	return &TokenRepository{db: db}
}

func (r *TokenRepository) Create(t *domain.PersonalAccessToken) error {
	return r.db.Create(t).Error
}

func (r *TokenRepository) ListByUser(userID string) ([]domain.PersonalAccessToken, error) {
	var out []domain.PersonalAccessToken
	err := r.db.Where("user_id = ?", userID).Order("created_at DESC").Find(&out).Error
	return out, err
}

// FindActiveByHash resolves a presented token. Expired tokens don't match.
func (r *TokenRepository) FindActiveByHash(hash []byte) (*domain.PersonalAccessToken, error) {
	var t domain.PersonalAccessToken
	err := r.db.
		Where("token_hash = ?", hash).
		Where("expires_at IS NULL OR expires_at > ?", time.Now()).
		First(&t).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrTokenNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Delete revokes a token, scoped to its owner so one user can't revoke another's.
func (r *TokenRepository) Delete(id, userID string) error {
	res := r.db.Where("id = ? AND user_id = ?", id, userID).Delete(&domain.PersonalAccessToken{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrTokenNotFound
	}
	return nil
}

// Update changes a token's name and scopes, scoped to its owner for the same
// reason Delete is: one user must not be able to re-permission another's token.
//
// Takes a map rather than a struct so an empty scope string — "make this
// read-only" — actually gets written. GORM's struct updates skip zero values,
// which would silently turn the most security-relevant edit into a no-op.
func (r *TokenRepository) Update(id, userID string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	res := r.db.Model(&domain.PersonalAccessToken{}).
		Where("id = ? AND user_id = ?", id, userID).
		Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrTokenNotFound
	}
	return nil
}

// FindByIDForUser reads one of the caller's own tokens.
func (r *TokenRepository) FindByIDForUser(id, userID string) (*domain.PersonalAccessToken, error) {
	var t domain.PersonalAccessToken
	if err := r.db.Where("id = ? AND user_id = ?", id, userID).First(&t).Error; err != nil {
		return nil, ErrTokenNotFound
	}
	return &t, nil
}

// TouchLastUsed records usage, throttled to at most one write per minute so a
// busy client doesn't add a DB write to every request.
func (r *TokenRepository) TouchLastUsed(id string, now time.Time) {
	r.db.Model(&domain.PersonalAccessToken{}).
		Where("id = ? AND (last_used_at IS NULL OR last_used_at < ?)", id, now.Add(-time.Minute)).
		Update("last_used_at", now)
}
