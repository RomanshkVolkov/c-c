package repository

import (
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

type SecretRefRepository struct{ db *gorm.DB }

func NewSecretRefRepository(db *gorm.DB) *SecretRefRepository { return &SecretRefRepository{db: db} }

func (r *SecretRefRepository) List(deployableID string) ([]domain.DeployableSecretRef, error) {
	out := []domain.DeployableSecretRef{}
	err := r.db.Where("deployable_id = ?", deployableID).Order("name").Find(&out).Error
	return out, err
}

// Replace deja la lista del servicio como la que llega, en una transacción.
func (r *SecretRefRepository) Replace(orgID, deployableID string, refs []domain.SecretRefInput) ([]domain.DeployableSecretRef, error) {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("deployable_id = ?", deployableID).Delete(&domain.DeployableSecretRef{}).Error; err != nil {
			return err
		}
		for _, in := range refs {
			row := domain.DeployableSecretRef{OrgID: orgID, DeployableID: deployableID, Name: in.Name, OpRef: in.OpRef}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return r.List(deployableID)
}

func (r *SecretRefRepository) RecordRotation(rot *domain.SecretRotation) error {
	return r.db.Create(rot).Error
}

func (r *SecretRefRepository) ListRotations(deployableID string, limit int) ([]domain.SecretRotationResponse, error) {
	out := []domain.SecretRotationResponse{}
	err := r.db.Table("secret_rotations s").
		Select("s.*, (SELECT "+nombreVisible+" FROM users WHERE id = s.started_by) AS started_by_name").
		Where("s.deployable_id = ?", deployableID).
		Order("s.created_at DESC").Limit(limit).
		Scan(&out).Error
	return out, err
}

// DeleteForDeployable: al borrar el servicio, sus referencias y su registro.
func (r *SecretRefRepository) DeleteForDeployable(tx *gorm.DB, deployableID string) error {
	if err := tx.Where("deployable_id = ?", deployableID).Delete(&domain.DeployableSecretRef{}).Error; err != nil {
		return err
	}
	return tx.Where("deployable_id = ?", deployableID).Delete(&domain.SecretRotation{}).Error
}
