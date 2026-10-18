package repository

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var (
	// ErrBackupInFlight: ya hay un backup (o una prueba de restauración) vivo
	// para esa base.
	ErrBackupInFlight = errors.New("backup-in-flight")
	// ErrBackupNotRunning: tocar un backup que no está en curso, o que no es de
	// ese servidor. Con el id de otro servidor, la misma respuesta: como si no
	// existiera.
	ErrBackupNotRunning = errors.New("backup-not-running")
)

// EnsureBackupIndexes: un solo trabajo vivo por base, garantizado por la base
// de datos y no por una comprobación en Go —el reloj de dos réplicas y un clic
// a la vez caben entre comprobar y escribir—. Cuenta también la prueba de
// restauración: restaurar mientras se respalda la misma base es pedirle dos
// veces el disco a la vez.
func EnsureBackupIndexes(db *gorm.DB) error {
	return db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_one_live
		ON backups (target_id) WHERE status IN ('queued','running')`).Error
}

type BackupRepository struct{ db *gorm.DB }

func NewBackupRepository(db *gorm.DB) *BackupRepository { return &BackupRepository{db: db} }

// ─── Bases ────────────────────────────────────────────────────────────────────

func (r *BackupRepository) CreateTarget(t *domain.BackupTarget) error { return r.db.Create(t).Error }

func (r *BackupRepository) SaveTarget(t *domain.BackupTarget) error { return r.db.Save(t).Error }

func (r *BackupRepository) FindTarget(serverID, id string) (*domain.BackupTarget, error) {
	var t domain.BackupTarget
	if err := r.db.First(&t, "id = ? AND server_id = ?", id, serverID).Error; err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *BackupRepository) ListTargets(serverID string) ([]domain.BackupTarget, error) {
	out := []domain.BackupTarget{}
	err := r.db.Where("server_id = ?", serverID).Order("created_at").Find(&out).Error
	return out, err
}

// DeleteTarget borra una base que no tiene nada vivo. Sus backups se quedan
// como historia y sus objetos los sigue borrando el conserje al vencer.
func (r *BackupRepository) DeleteTarget(serverID, id string) error {
	var live int64
	if err := r.db.Model(&domain.Backup{}).
		Where("target_id = ? AND status IN ?", id, []string{domain.BackupQueued, domain.BackupRunning}).
		Count(&live).Error; err != nil {
		return err
	}
	if live > 0 {
		return ErrBackupInFlight
	}
	return r.db.Where("id = ? AND server_id = ?", id, serverID).Delete(&domain.BackupTarget{}).Error
}

// DueTargets: las bases encendidas a las que ya les tocó.
func (r *BackupRepository) DueTargets(now time.Time) ([]domain.BackupTarget, error) {
	out := []domain.BackupTarget{}
	err := r.db.Where("enabled AND next_run_at IS NOT NULL AND next_run_at <= ?", now).Find(&out).Error
	return out, err
}

// ReserveRun mueve la siguiente hora de una base sólo si sigue siendo la que
// se vio: con dos réplicas del backend, sólo una gana y encola. Es el mismo
// compare-and-swap que el de las reuniones (`MeetingRepository.Reservar`).
func (r *BackupRepository) ReserveRun(id string, seen, next time.Time) (bool, error) {
	res := r.db.Model(&domain.BackupTarget{}).
		Where("id = ? AND next_run_at = ?", id, seen).
		Update("next_run_at", next)
	return res.RowsAffected == 1, res.Error
}

// DueRestoreTests: las bases a las que les toca probar restaurar.
func (r *BackupRepository) DueRestoreTests(now time.Time) ([]domain.BackupTarget, error) {
	out := []domain.BackupTarget{}
	err := r.db.Where("enabled AND restore_test_every_days > 0 AND next_restore_test_at IS NOT NULL AND next_restore_test_at <= ?", now).
		Find(&out).Error
	return out, err
}

// ReserveRestoreTest: el mismo compare-and-swap para la prueba.
func (r *BackupRepository) ReserveRestoreTest(id string, seen, next time.Time) (bool, error) {
	res := r.db.Model(&domain.BackupTarget{}).
		Where("id = ? AND next_restore_test_at = ?", id, seen).
		Update("next_restore_test_at", next)
	return res.RowsAffected == 1, res.Error
}

// WatchedTargets: las encendidas que todavía no avisaron de estar sin backup.
// El umbral depende del intervalo de cada una, así que la cuenta la hace quien
// llama.
func (r *BackupRepository) WatchedTargets() ([]domain.BackupTarget, error) {
	out := []domain.BackupTarget{}
	err := r.db.Where("enabled AND stale_notified_at IS NULL").Find(&out).Error
	return out, err
}

// MarkStaleNotified apunta el aviso sólo si nadie lo apuntó antes: con dos
// réplicas, un solo aviso.
func (r *BackupRepository) MarkStaleNotified(id string, now time.Time) (bool, error) {
	res := r.db.Model(&domain.BackupTarget{}).
		Where("id = ? AND stale_notified_at IS NULL", id).
		Update("stale_notified_at", now)
	return res.RowsAffected == 1, res.Error
}

// ─── Backups ──────────────────────────────────────────────────────────────────

// CreateBackup encola. Con algo vivo para la misma base, `ErrBackupInFlight`.
func (r *BackupRepository) CreateBackup(b *domain.Backup) error {
	err := r.db.Create(b).Error
	if err != nil && isUniqueViolation(err) {
		return ErrBackupInFlight
	}
	return err
}

// ClaimNext: el más viejo en cola de ese servidor, marcado en curso en una
// sola sentencia, como `DeployRepository.ClaimNext`.
func (r *BackupRepository) ClaimNext(serverID string, now time.Time) (*domain.Backup, error) {
	var claimed []domain.Backup
	err := r.db.Raw(`UPDATE backups SET status = ?, started_at = ?, updated_at = ?
		WHERE id = (
			SELECT id FROM backups
			WHERE server_id = ? AND status = ?
			ORDER BY created_at
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`, domain.BackupRunning, now, now, serverID, domain.BackupQueued).Scan(&claimed).Error
	if err != nil || len(claimed) == 0 {
		return nil, err
	}
	return &claimed[0], nil
}

// AppendLog: como el de los deploys, sólo a uno en curso de ese servidor.
func (r *BackupRepository) AppendLog(serverID, id string, lines []string) (*domain.Backup, error) {
	chunk := strings.Join(lines, "\n") + "\n"
	var rows []domain.Backup
	err := r.db.Raw(`UPDATE backups SET log = CASE
			WHEN length(log) >= ? THEN log
			WHEN length(log) + length(?) > ? THEN log || ?
			ELSE log || ? END,
		updated_at = now()
		WHERE id = ? AND server_id = ? AND status = ?
		RETURNING id, org_id, server_id, target_id, kind, status`,
		domain.BackupLogMax, chunk, domain.BackupLogMax, "[… log truncated: size limit reached]\n", chunk,
		id, serverID, domain.BackupRunning).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrBackupNotRunning
	}
	return &rows[0], nil
}

// FindRunning: un backup en curso de ese servidor, con su base.
func (r *BackupRepository) FindRunning(serverID, id string) (*domain.Backup, *domain.BackupTarget, error) {
	var b domain.Backup
	if err := r.db.First(&b, "id = ? AND server_id = ? AND status = ?", id, serverID, domain.BackupRunning).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrBackupNotRunning
		}
		return nil, nil, err
	}
	var t domain.BackupTarget
	if err := r.db.First(&t, "id = ?", b.TargetID).Error; err != nil {
		return nil, nil, err
	}
	return &b, &t, nil
}

// SetObject apunta dónde va a quedar el fichero. Antes de firmar la subida:
// si el agente muere a medias, la fila ya dice qué objeto buscar.
func (r *BackupRepository) SetObject(id, key string, size int64, sha string, retainUntil time.Time, class string) error {
	return r.db.Model(&domain.Backup{}).Where("id = ? AND status = ?", id, domain.BackupRunning).
		Updates(map[string]any{
			"object_key": key, "size_bytes": size, "sha256": sha,
			"retain_until": retainUntil, "retention_class": class,
		}).Error
}

// Finish cierra uno en curso de ese servidor y pone su base al día: un backup
// bueno rearma el aviso de «sin backup»; una prueba de restauración deja su
// resultado.
func (r *BackupRepository) Finish(serverID, id string, req domain.AgentBackupFinishRequest, now time.Time) (*domain.Backup, *domain.BackupTarget, error) {
	var b domain.Backup
	var t domain.BackupTarget
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&b, "id = ? AND server_id = ? AND status = ?", id, serverID, domain.BackupRunning).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrBackupNotRunning
			}
			return err
		}
		status := req.Status
		// Un backup «bueno» sin objeto no lo es: no hay nada que restaurar.
		if b.Kind != domain.BackupKindRestoreTest && status == domain.BackupSucceeded && b.ObjectKey == "" {
			status, req.Error = domain.BackupFailed, "backup-without-object"
		}
		b.Status, b.Error, b.FinishedAt = status, req.Error, &now
		if err := tx.Model(&b).Updates(map[string]any{
			"status": b.Status, "error": b.Error, "finished_at": now,
		}).Error; err != nil {
			return err
		}
		if err := tx.First(&t, "id = ?", b.TargetID).Error; err != nil {
			return err
		}
		upd := map[string]any{}
		switch {
		case b.Kind == domain.BackupKindRestoreTest:
			ok := status == domain.BackupSucceeded
			upd["last_restore_test_at"], upd["last_restore_test_ok"] = now, ok
			t.LastRestoreTestAt, t.LastRestoreTestOK = &now, &ok
		case status == domain.BackupSucceeded:
			upd["last_success_at"], upd["stale_notified_at"] = now, nil
			t.LastSuccessAt, t.StaleNotifiedAt = &now, nil
		}
		if len(upd) > 0 {
			return tx.Model(&domain.BackupTarget{}).Where("id = ?", t.ID).Updates(upd).Error
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return &b, &t, nil
}

// ExpireStale da por fallidos los que llevan demasiado en curso: un agente que
// murió a medias no bloquea la base para siempre.
func (r *BackupRepository) ExpireStale(now time.Time) ([]domain.Backup, error) {
	var expired []domain.Backup
	err := r.db.Model(&expired).Clauses(clause.Returning{}).
		Where("status = ? AND started_at < ?", domain.BackupRunning, now.Add(-domain.BackupStaleAfter)).
		Updates(map[string]any{"status": domain.BackupFailed, "error": "backup-expired", "finished_at": now}).Error
	return expired, err
}

// LastSucceeded: el último backup bueno de una base (no una prueba), el que se
// prueba a restaurar.
func (r *BackupRepository) LastSucceeded(targetID string) (*domain.Backup, error) {
	var b domain.Backup
	err := r.db.Where("target_id = ? AND kind <> ? AND status = ? AND object_key <> '' AND purged_at IS NULL",
		targetID, domain.BackupKindRestoreTest, domain.BackupSucceeded).
		Order("finished_at DESC").First(&b).Error
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// FindBackup: uno de ese servidor.
func (r *BackupRepository) FindBackup(serverID, id string) (*domain.Backup, error) {
	var b domain.Backup
	if err := r.db.First(&b, "id = ? AND server_id = ?", id, serverID).Error; err != nil {
		return nil, err
	}
	return &b, nil
}

// ListBackups: el historial de una base, sin el log.
func (r *BackupRepository) ListBackups(serverID, targetID string, limit int) ([]domain.Backup, error) {
	out := []domain.Backup{}
	err := r.db.Omit("log").Where("server_id = ? AND target_id = ?", serverID, targetID).
		Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// Purgeable: los objetos cuya retención venció y que siguen en S3.
func (r *BackupRepository) Purgeable(now time.Time, limit int) ([]domain.Backup, error) {
	out := []domain.Backup{}
	err := r.db.Where("object_key <> '' AND purged_at IS NULL AND retain_until IS NOT NULL AND retain_until < ?", now).
		Order("retain_until").Limit(limit).Find(&out).Error
	return out, err
}

func (r *BackupRepository) MarkPurged(id string, now time.Time) error {
	return r.db.Model(&domain.Backup{}).Where("id = ?", id).Update("purged_at", now).Error
}

// ─── Destinatarios ────────────────────────────────────────────────────────────

// Recipients: para quién se cifra en ese servidor. Los de la organización
// (`server_id` vacío) más la llave de restauración de ese servidor.
func (r *BackupRepository) Recipients(orgID, serverID string) ([]domain.BackupRecipient, error) {
	out := []domain.BackupRecipient{}
	err := r.db.Where("org_id = ? AND (server_id = '' OR server_id = ?)", orgID, serverID).
		Order("created_at").Find(&out).Error
	return out, err
}

func (r *BackupRepository) OrgRecipients(orgID string) ([]domain.BackupRecipient, error) {
	out := []domain.BackupRecipient{}
	err := r.db.Where("org_id = ? AND server_id = ''", orgID).Order("created_at").Find(&out).Error
	return out, err
}

func (r *BackupRepository) AddRecipient(rc *domain.BackupRecipient) error {
	return r.db.Create(rc).Error
}

func (r *BackupRepository) DeleteRecipient(orgID, id string) error {
	return r.db.Where("id = ? AND org_id = ? AND server_id = ''", id, orgID).Delete(&domain.BackupRecipient{}).Error
}

// SetServerRecipient pone (o cambia) la llave de restauración de un servidor.
func (r *BackupRepository) SetServerRecipient(orgID, serverID, publicKey string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("org_id = ? AND server_id = ?", orgID, serverID).Delete(&domain.BackupRecipient{}).Error; err != nil {
			return err
		}
		return tx.Create(&domain.BackupRecipient{
			OrgID: orgID, ServerID: serverID, Label: "restore-test", PublicKey: publicKey,
		}).Error
	})
}
