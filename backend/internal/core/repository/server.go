package repository

import (
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

type ServerRepository struct {
	db *gorm.DB
}

func NewServerRepository(db *gorm.DB) *ServerRepository {
	return &ServerRepository{db: db}
}

func (r *ServerRepository) Create(server *domain.Server) error {
	return r.db.Create(server).Error
}

func (r *ServerRepository) List() ([]domain.Server, error) {
	var servers []domain.Server
	if err := r.db.Find(&servers).Error; err != nil {
		return nil, err
	}
	return servers, nil
}

func (r *ServerRepository) FindByID(id string) (*domain.Server, error) {
	var server domain.Server
	if err := r.db.First(&server, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &server, nil
}

func (r *ServerRepository) UpdateStatus(id, status string) error {
	return r.db.Model(&domain.Server{}).Where("id = ?", id).Update("status", status).Error
}

func (r *ServerRepository) Delete(id string) error {
	return r.db.Delete(&domain.Server{}, "id = ?", id).Error
}
