package repository

import (
	"errors"
	"fmt"
	"time"

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

// ─── Peticiones de ejecución ──────────────────────────────────────────────────

// Cada cambio de estado de una petición es una sola sentencia condicionada al
// estado de partida (y a la hora, donde cuenta): comprobar primero y escribir
// después dejaría que dos aprobaciones, o dos ejecuciones con la misma
// autorización, pasaran las dos. Si la condición no casa, `domain.ErrRequestState`
// y nada cambia.

func (r *ProvisioningRepository) CreateRequest(p *domain.ProvisioningRequest) error {
	return r.db.Create(p).Error
}

const requestNames = "p.*, " +
	"(SELECT " + nombreVisible + " FROM users WHERE id = p.requested_by) AS requested_by_name, " +
	"(SELECT " + nombreVisible + " FROM users WHERE id = p.decided_by) AS decided_by_name"

func (r *ProvisioningRepository) Request(serverID, id string) (*domain.ProvisioningRequestResponse, error) {
	var out []domain.ProvisioningRequestResponse
	if err := r.db.Table("provisioning_requests p").Select(requestNames).
		Where("p.id = ? AND p.server_id = ?", id, serverID).Limit(1).Find(&out).Error; err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, domain.ErrRequestNotFound
	}
	return &out[0], nil
}

func (r *ProvisioningRepository) Requests(serverID string, limit int) ([]domain.ProvisioningRequestResponse, error) {
	out := []domain.ProvisioningRequestResponse{}
	err := r.db.Table("provisioning_requests p").Select(requestNames).
		Where("p.server_id = ?", serverID).Order("p.created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// SubmitCheck guarda el ensayo y su evaluación, sólo si la petición sigue
// esperando su ensayo y no ha caducado. Un ensayo se manda una vez: otro
// ensayo es otra petición. La caducidad la mira antes el servicio (y la
// prueba `TestAGrantExpires`); la de aquí cubre sólo la carrera entre leer y
// escribir, y por eso ninguna prueba la rompe sola.
func (r *ProvisioningRepository) SubmitCheck(serverID, id string, now time.Time, check domain.ProvisioningCheck, flags []domain.RiskFlag, status string, auto bool, grantExpires *time.Time) error {
	p := domain.ProvisioningRequest{
		Check: &check, Flags: flags, CheckedAt: &now, Status: status,
		AutoApproved: auto, GrantExpiresAt: grantExpires,
	}
	if auto {
		p.DecidedAt = &now
	}
	// Select + struct (no `Updates(map…)`): así corre el serializador de las
	// columnas jsonb.
	res := r.db.Model(&domain.ProvisioningRequest{}).
		Where("id = ? AND server_id = ? AND status = ? AND created_at > ?",
			id, serverID, domain.ProvisioningRequestChecking, now.Add(-domain.ProvisioningDecisionTTL)).
		Select("dry_run", "flags", "checked_at", "status", "auto_approved", "grant_expires_at", "decided_at").
		Updates(&p)
	return oneRow(res)
}

// Discard: sólo sobre una que sigue esperando su ensayo, en la misma sentencia
// (si el ensayo llega a la vez, gana uno de los dos, no los dos).
func (r *ProvisioningRepository) Discard(serverID, id string, now time.Time, by string) error {
	res := r.db.Model(&domain.ProvisioningRequest{}).
		Where("id = ? AND server_id = ? AND status = ?", id, serverID, domain.ProvisioningRequestChecking).
		Updates(map[string]any{"status": domain.ProvisioningRequestDiscarded, "decided_by": by, "decided_at": now})
	return oneRow(res)
}

// Decide aprueba o rechaza, sólo si espera decisión y no ha caducado.
func (r *ProvisioningRepository) Decide(serverID, id string, now time.Time, fields map[string]any) error {
	res := r.db.Model(&domain.ProvisioningRequest{}).
		Where("id = ? AND server_id = ? AND status = ? AND created_at > ?",
			id, serverID, domain.ProvisioningRequestAwaiting, now.Add(-domain.ProvisioningDecisionTTL)).
		Updates(fields)
	return oneRow(res)
}

// StartWithGrant gasta la autorización y abre la ejecución en la misma
// transacción. La autorización casa con lo aprobado —este servidor, este
// playbook, esta versión de la config— y no ha caducado; si la ejecución no
// se puede abrir, la autorización no se gasta.
//
// Gasta la del playbook (approved → running) o, después, la de su
// verificación (verifying, con `verify` igual al playbook y aún sin correr).
func (r *ProvisioningRepository) StartWithGrant(run *domain.ProvisioningRun, now time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&domain.ProvisioningRequest{}).
			Where("id = ? AND server_id = ? AND status = ? AND grant_expires_at > ? AND playbook = ? AND config_seq = ? AND run_id = ''",
				run.RequestID, run.ServerID, domain.ProvisioningRequestApproved, now, run.Playbook, run.ConfigSeq).
			Updates(map[string]any{"status": domain.ProvisioningRequestRunning, "run_id": run.ID})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			res = tx.Model(&domain.ProvisioningRequest{}).
				Where("id = ? AND server_id = ? AND status = ? AND verify = ? AND verify <> '' AND config_seq = ? AND verify_run_id = ''",
					run.RequestID, run.ServerID, domain.ProvisioningRequestVerifying, run.Playbook, run.ConfigSeq).
				Updates(map[string]any{"verify_run_id": run.ID})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return domain.ErrGrantMismatch
			}
		}
		return tx.Create(run).Error
	})
}

// MoveRequest pasa la petición de un estado a otro, si sigue en el primero.
func (r *ProvisioningRepository) MoveRequest(id, from, to string) error {
	return oneRow(r.db.Model(&domain.ProvisioningRequest{}).
		Where("id = ? AND status = ?", id, from).Update("status", to))
}

// ReopenRequest suelta la ejecución que no llegó a arrancar (`run_id` o
// `verify_run_id` a vacío) y deja la petición en `to`, si seguía en `from`.
// La autorización (`grant_expires_at`) no se toca: sigue valiendo lo que le
// quedaba.
func (r *ProvisioningRepository) ReopenRequest(id, from, to, runColumn string) error {
	if runColumn != "run_id" && runColumn != "verify_run_id" {
		return fmt.Errorf("reopen request: unknown column %q", runColumn)
	}
	return oneRow(r.db.Model(&domain.ProvisioningRequest{}).
		Where("id = ? AND status = ?", id, from).
		Updates(map[string]any{"status": to, runColumn: ""}))
}

// Run: una ejecución, para saber al cerrarla de qué petición era.
func (r *ProvisioningRepository) Run(serverID, id string) (*domain.ProvisioningRun, error) {
	var run domain.ProvisioningRun
	if err := r.db.Where("id = ? AND server_id = ?", id, serverID).First(&run).Error; err != nil {
		return nil, err
	}
	return &run, nil
}

func oneRow(res *gorm.DB) error {
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return domain.ErrRequestState
	}
	return nil
}
