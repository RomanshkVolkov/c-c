package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

// ErrProvisioningNotRunning: cerrar una ejecución que ya se cerró.
var ErrProvisioningNotRunning = errors.New("provisioning-not-running")

type ProvisioningRepository struct{ db *gorm.DB }

func NewProvisioningRepository(db *gorm.DB) *ProvisioningRepository {
	return &ProvisioningRepository{db: db}
}

func (r *ProvisioningRepository) Create(run *domain.ProvisioningRun) error {
	return r.db.Create(run).Error
}

// Finish cierra la ejecución **sólo si sigue abierta**, en la misma sentencia.
// Comprobar primero y escribir después dejaría que dos cierres —la app que
// termina y la que, al arrancar, marca «interrumpida» la que quedó colgada—
// se pisaran.
func (r *ProvisioningRepository) Finish(serverID, id string, fields map[string]any) error {
	res := r.db.Model(&domain.ProvisioningRun{}).
		Where("id = ? AND server_id = ? AND status = ?", id, serverID, domain.ProvisioningRunning).
		Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrProvisioningNotRunning
	}
	return nil
}

// ListByServer: las más recientes primero, con el nombre de quien las lanzó.
func (r *ProvisioningRepository) ListByServer(serverID string, limit int) ([]domain.ProvisioningRunResponse, error) {
	out := []domain.ProvisioningRunResponse{}
	err := r.db.Table("provisioning_runs p").
		Select("p.*, (SELECT "+nombreVisible+" FROM users WHERE id = p.started_by) AS started_by_name").
		Where("p.server_id = ?", serverID).
		Order("p.started_at DESC").
		Limit(limit).
		Scan(&out).Error
	return out, err
}
