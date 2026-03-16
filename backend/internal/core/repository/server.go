package repository

import (
	"fmt"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/zalando/go-keyring"
	"gorm.io/gorm"
)

const keychainService = "cac-vps"

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
	_ = keyring.Delete(keychainService, id)
	return r.db.Delete(&domain.Server{}, "id = ?", id).Error
}

// ─── Keychain helpers ─────────────────────────────────────────────────────────

func StoreSSHKey(serverID, privateKey string) error {
	if err := keyring.Set(keychainService, serverID, privateKey); err != nil {
		return fmt.Errorf("keychain set: %w", err)
	}
	return nil
}

func GetSSHKey(serverID string) (string, error) {
	key, err := keyring.Get(keychainService, serverID)
	if err != nil {
		return "", fmt.Errorf("keychain get: %w", err)
	}
	return key, nil
}

func DeleteSSHKey(serverID string) error {
	return keyring.Delete(keychainService, serverID)
}
