package repository

import (
	"errors"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	// ErrDeployInFlight: ya hay un deploy en cola o en curso para ese servicio.
	ErrDeployInFlight = errors.New("deploy-in-flight")
	// ErrDeployNotRunning: cerrar o loguear un deploy que no está en curso, o
	// que no es de este servidor.
	ErrDeployNotRunning = errors.New("deploy-not-running")
)

// EnsureDeployIndexes crea lo que las etiquetas de GORM no saben decir. Se
// llama desde `db.go` y desde las bases de las pruebas: sin ellos, lo que
// sostienen no estaría en ninguna parte de lo que se prueba.
func EnsureDeployIndexes(db *gorm.DB) error {
	// Un solo deploy vivo por servicio, y lo garantiza la base. Dos clics
	// seguidos —o el CI y una persona a la vez— son dos INSERT en vuelo:
	// comprobar antes en Go no sirve, porque entre la comprobación y la
	// escritura cabe el otro. Con el índice, el segundo choca.
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_one_live
		ON deployments (deployable_id) WHERE status IN ('queued','running')`).Error; err != nil {
		return err
	}
	// El mismo aviso del CI dos veces es un solo deployment.
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_idempotency
		ON deployments (deployable_id, idempotency_key) WHERE idempotency_key <> ''`).Error; err != nil {
		return err
	}
	// Y un solo build por commit: el CI que reintenta no duplica versiones.
	return db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_image_builds_sha
		ON image_builds (deployable_id, sha)`).Error
}

type DeployRepository struct{ db *gorm.DB }

func NewDeployRepository(db *gorm.DB) *DeployRepository { return &DeployRepository{db: db} }

// ─── Deployables ──────────────────────────────────────────────────────────────

func (r *DeployRepository) CreateDeployable(d *domain.Deployable) error {
	return r.db.Create(d).Error
}

func (r *DeployRepository) ListDeployables(serverID string) ([]domain.Deployable, error) {
	out := []domain.Deployable{}
	err := r.db.Where("server_id = ?", serverID).Order("name").Find(&out).Error
	return out, err
}

// FindDeployable: sólo si es de ese servidor. Un id bueno de otro servidor no
// existe para esta ruta.
func (r *DeployRepository) FindDeployable(serverID, id string) (*domain.Deployable, error) {
	var d domain.Deployable
	if err := r.db.First(&d, "id = ? AND server_id = ?", id, serverID).Error; err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *DeployRepository) UpdateDeployable(d *domain.Deployable) error {
	return r.db.Model(&domain.Deployable{}).Where("id = ?", d.ID).Updates(map[string]any{
		"name":           d.Name,
		"environment":    d.Environment,
		"repo_full_name": d.RepoFullName,
		"on_ci_notify":   d.OnCINotify,
		"build_workflow": d.BuildWorkflow,
		"short_tags":     d.ShortTags,
	}).Error
}

func (r *DeployRepository) DeleteDeployable(serverID, id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("deployable_id = ?", id).Delete(&domain.Deployment{}).Error; err != nil {
			return err
		}
		if err := tx.Where("deployable_id = ?", id).Delete(&domain.ImageBuild{}).Error; err != nil {
			return err
		}
		if err := (&SecretRefRepository{}).DeleteForDeployable(tx, id); err != nil {
			return err
		}
		return tx.Where("id = ? AND server_id = ?", id, serverID).Delete(&domain.Deployable{}).Error
	})
}

// SetCIKey guarda la llave nueva del CI; la anterior deja de valer.
func (r *DeployRepository) SetCIKey(id string, hash []byte, preview string) error {
	return r.db.Model(&domain.Deployable{}).Where("id = ?", id).Updates(map[string]any{
		"ci_key_hash": hash, "ci_key_preview": preview,
	}).Error
}

// FindDeployableByCIKey: el deployable de una llave del CI. Los que no tienen
// llave la tienen en NULL, que no casa con ningún hash.
func (r *DeployRepository) FindDeployableByCIKey(hash []byte) (*domain.Deployable, error) {
	var d domain.Deployable
	if err := r.db.First(&d, "ci_key_hash = ?", hash).Error; err != nil {
		return nil, err
	}
	return &d, nil
}

// ─── Builds ───────────────────────────────────────────────────────────────────

// RecordBuild apunta un build, o devuelve el que ya había para ese commit.
func (r *DeployRepository) RecordBuild(b *domain.ImageBuild) (*domain.ImageBuild, error) {
	res := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(b)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 1 {
		return b, nil
	}
	var existing domain.ImageBuild
	err := r.db.First(&existing, "deployable_id = ? AND sha = ?", b.DeployableID, b.Sha).Error
	return &existing, err
}

func (r *DeployRepository) ListBuilds(deployableID string, limit int) ([]domain.ImageBuild, error) {
	out := []domain.ImageBuild{}
	err := r.db.Where("deployable_id = ?", deployableID).Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// ─── Deployments ──────────────────────────────────────────────────────────────

// ExpireStale da por fallidos los deployments que llevan demasiado «en curso»:
// un agente que murió a medias no puede bloquear el servicio para siempre.
func (r *DeployRepository) ExpireStale(deployableID string, now time.Time) ([]domain.Deployment, error) {
	var expired []domain.Deployment
	err := r.db.Model(&expired).Clauses(clause.Returning{}).
		Where("deployable_id = ? AND status = ? AND started_at < ?", deployableID, domain.DeployRunning, now.Add(-domain.DeployStaleAfter)).
		Updates(map[string]any{
			"status": domain.DeployFailed,
			// Un código y no una frase: la app lo dice en el idioma de cada quien.
			"error":       "agent-stopped-responding",
			"finished_at": now,
		}).Error
	return expired, err
}

// CreateDeployment encola. Con un deploy vivo para el mismo servicio, choca
// con el índice y contesta `ErrDeployInFlight`.
func (r *DeployRepository) CreateDeployment(d *domain.Deployment) error {
	err := r.db.Create(d).Error
	if err != nil && isUniqueViolation(err) {
		return ErrDeployInFlight
	}
	return err
}

// FindByIdempotency: el deployment que ya abrió ese aviso, si lo hay.
func (r *DeployRepository) FindByIdempotency(deployableID, key string) (*domain.Deployment, error) {
	var d domain.Deployment
	if err := r.db.First(&d, "deployable_id = ? AND idempotency_key = ?", deployableID, key).Error; err != nil {
		return nil, err
	}
	return &d, nil
}

// ClaimNext le da al agente de `serverID` el deployment más viejo en cola y lo
// marca en curso, en una sola sentencia. `SKIP LOCKED` es lo que lo hace
// correcto con dos réplicas del backend: dos preguntas a la vez nunca se
// llevan el mismo.
func (r *DeployRepository) ClaimNext(serverID string, now time.Time) (*domain.Deployment, error) {
	var claimed []domain.Deployment
	err := r.db.Raw(`UPDATE deployments SET status = ?, started_at = ?, updated_at = ?
		WHERE id = (
			SELECT id FROM deployments
			WHERE server_id = ? AND status = ?
			ORDER BY created_at
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`, domain.DeployRunning, now, now, serverID, domain.DeployQueued).Scan(&claimed).Error
	if err != nil || len(claimed) == 0 {
		return nil, err
	}
	return &claimed[0], nil
}

// AppendLog añade líneas a un deployment **en curso de ese servidor**, con
// tope. Pasado el tope se deja una marca y no se escribe más. Devuelve de qué
// org y deployable es, para publicarlo sin otra consulta.
func (r *DeployRepository) AppendLog(serverID, id string, lines []string) (orgID, deployableID string, err error) {
	chunk := strings.Join(lines, "\n") + "\n"
	var rows []struct{ OrgID, DeployableID string }
	err = r.db.Raw(`UPDATE deployments SET log = CASE
			WHEN length(log) >= ? THEN log
			WHEN length(log) + length(?) > ? THEN log || ?
			ELSE log || ? END,
		updated_at = now()
		WHERE id = ? AND server_id = ? AND status = ?
		RETURNING org_id, deployable_id`,
		domain.DeployLogMax, chunk, domain.DeployLogMax, "[… log truncated: size limit reached]\n", chunk,
		id, serverID, domain.DeployRunning).Scan(&rows).Error
	if err != nil {
		return "", "", err
	}
	if len(rows) == 0 {
		return "", "", ErrDeployNotRunning
	}
	return rows[0].OrgID, rows[0].DeployableID, nil
}

// Finish cierra un deployment en curso de ese servidor y, si salió bien, lo
// apunta en su deployable como lo desplegado; si era un rollback, marca el
// deployment del que se volvía.
func (r *DeployRepository) Finish(serverID, id string, req domain.AgentFinishRequest, now time.Time) (*domain.Deployment, error) {
	var out *domain.Deployment
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var d domain.Deployment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&d, "id = ? AND server_id = ? AND status = ?", id, serverID, domain.DeployRunning).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrDeployNotRunning
			}
			return err
		}
		d.Status = req.Status
		d.Error = req.Error
		d.PreviousImage = req.PreviousImage
		d.FinalImage = req.FinalImage
		d.FinishedAt = &now
		if err := tx.Model(&d).Updates(map[string]any{
			"status": d.Status, "error": d.Error, "previous_image": d.PreviousImage,
			"final_image": d.FinalImage, "finished_at": now,
		}).Error; err != nil {
			return err
		}
		if d.Status == domain.DeploySucceeded {
			if err := tx.Model(&domain.Deployable{}).Where("id = ?", d.DeployableID).Updates(map[string]any{
				"current_image": d.FinalImage, "previous_image": d.PreviousImage,
			}).Error; err != nil {
				return err
			}
			if d.RollbackOfID != "" {
				if err := tx.Model(&domain.Deployment{}).Where("id = ?", d.RollbackOfID).
					Update("status", domain.DeployRolledBack).Error; err != nil {
					return err
				}
			}
		}
		out = &d
		return nil
	})
	return out, err
}

func (r *DeployRepository) FindDeployment(deployableID, id string) (*domain.Deployment, error) {
	var d domain.Deployment
	if err := r.db.First(&d, "id = ? AND deployable_id = ?", id, deployableID).Error; err != nil {
		return nil, err
	}
	return &d, nil
}

// ListDeployments: el historial de un deployable, sin el log, con el nombre de
// quien lo pidió.
func (r *DeployRepository) ListDeployments(deployableID string, limit int) ([]domain.DeploymentSummary, error) {
	out := []domain.DeploymentSummary{}
	err := r.db.Table("deployments d").
		Select(`d.id, d.created_at, d.updated_at, d.org_id, d.deployable_id, d.server_id, d.image,
			d.final_image, d.previous_image, d.requested_by, d.requested_by_user_id, d.status, d.error,
			d.started_at, d.finished_at, d.rollback_of_id,
			(SELECT `+nombreVisible+` FROM users WHERE id = d.requested_by_user_id) AS requested_by_name`).
		Where("d.deployable_id = ?", deployableID).
		Order("d.created_at DESC").
		Limit(limit).
		Scan(&out).Error
	return out, err
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

func (r *DeployRepository) FindDeploymentByID(id string) (*domain.Deployment, error) {
	var d domain.Deployment
	if err := r.db.First(&d, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *DeployRepository) SetGitHubDeploymentID(id string, ghID int64) error {
	return r.db.Model(&domain.Deployment{}).Where("id = ?", id).Update("github_deployment_id", ghID).Error
}

// DeployablesBuiltBy: los servicios de una org cuyo repo es éste y que dicen
// qué workflow publica su imagen.
func (r *DeployRepository) DeployablesBuiltBy(orgID, repoFullName string) ([]domain.Deployable, error) {
	var out []domain.Deployable
	err := r.db.Where("org_id = ? AND LOWER(repo_full_name) = LOWER(?) AND build_workflow <> ''", orgID, repoFullName).
		Find(&out).Error
	return out, err
}
