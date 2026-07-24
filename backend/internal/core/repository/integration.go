package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var ErrIntegrationNotFound = errors.New("integration not found")

type IntegrationRepository struct {
	db *gorm.DB
}

func NewIntegrationRepository(db *gorm.DB) *IntegrationRepository {
	return &IntegrationRepository{db: db}
}

func (r *IntegrationRepository) Create(it *domain.ServerIntegration) error {
	return r.db.Create(it).Error
}

func (r *IntegrationRepository) ListByServer(serverID string) ([]domain.ServerIntegration, error) {
	var out []domain.ServerIntegration
	err := r.db.Where("server_id = ?", serverID).Order("created_at ASC").Find(&out).Error
	return out, err
}

func (r *IntegrationRepository) FindByID(id string) (*domain.ServerIntegration, error) {
	var it domain.ServerIntegration
	if err := r.db.First(&it, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrIntegrationNotFound
		}
		return nil, err
	}
	return &it, nil
}

// Update applies a set of column updates by id.
func (r *IntegrationRepository) Update(id string, fields map[string]any) error {
	res := r.db.Model(&domain.ServerIntegration{}).Where("id = ?", id).Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrIntegrationNotFound
	}
	return nil
}

func (r *IntegrationRepository) Delete(id string) error {
	res := r.db.Delete(&domain.ServerIntegration{}, "id = ?", id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrIntegrationNotFound
	}
	return nil
}
