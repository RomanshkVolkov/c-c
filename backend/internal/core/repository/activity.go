package repository

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ActivityRepository: los runs de GitHub Actions de los repos de la org, y el
// feed que los mezcla con los deploys. Ver domain/activity.go.
type ActivityRepository struct{ db *gorm.DB }

func NewActivityRepository(db *gorm.DB) *ActivityRepository { return &ActivityRepository{db: db} }

// UpsertRun escribe o avanza un intento de un run. **Nunca retrocede**: un
// webhook tardío de `in_progress` no pisa un `completed`, porque el UPDATE
// sólo se aplica cuando lo que llega está igual o más adelante en
// `status_rank` (ver domain.WorkflowRunRank). Con el empate se refrescan los
// datos (actor, enlace…) por si la entrega anterior llegó coja.
//
// Devuelve la fila **como quedó en la base**, gane quien gane, y si esta
// escritura la hizo **avanzar** de rango. `advanced` es lo que distingue el
// `completed` que acaba de llegar de la reentrega del mismo `completed`, y por
// eso la campana suena una vez y no cada vez que GitHub reintenta.
//
// En una transacción con la fila anterior bloqueada: dos entregas del mismo
// intento a la vez se ordenan, y la segunda ve el rango que dejó la primera.
func (r *ActivityRepository) UpsertRun(run *domain.WorkflowRun) (stored *domain.WorkflowRun, advanced bool, err error) {
	run.StatusRank = domain.WorkflowRunRank(run.Status)
	if run.RunAttempt < 1 {
		run.RunAttempt = 1
	}
	err = r.db.Transaction(func(tx *gorm.DB) error {
		var before domain.WorkflowRun
		had := true
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&before, "run_id = ? AND run_attempt = ?", run.RunID, run.RunAttempt).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			had = false
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "run_id"}, {Name: "run_attempt"}},
			// Todo lo que GitHub puede mandar distinto entre una entrega y otra.
			// También `occurred_at`: es el `run_started_at` del intento, y el
			// primer aviso («requested») llega sin él.
			DoUpdates: clause.AssignmentColumns([]string{
				"status", "conclusion", "status_rank", "actor", "head_sha", "head_branch",
				"commit_title", "html_url", "workflow_name", "path", "event", "run_number",
				"run_started_at", "event_updated_at", "updated_at", "occurred_at",
			}),
			Where: clause.Where{Exprs: []clause.Expression{
				clause.Expr{SQL: "EXCLUDED.status_rank >= workflow_runs.status_rank"},
			}},
		}).Create(run).Error; err != nil {
			return err
		}
		var after domain.WorkflowRun
		if err := tx.First(&after, "run_id = ? AND run_attempt = ?", run.RunID, run.RunAttempt).Error; err != nil {
			return err
		}
		stored = &after
		advanced = !had || after.StatusRank > before.StatusRank
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return stored, advanced, nil
}

// FindRun: una fila por su id.
func (r *ActivityRepository) FindRun(id string) (*domain.WorkflowRun, error) {
	var run domain.WorkflowRun
	if err := r.db.First(&run, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &run, nil
}

// ─── El feed ──────────────────────────────────────────────────────────────────

// feedKey: lo que la primera consulta devuelve de cada entrada: lo justo para
// ordenar y paginar. Lo demás se trae después, por ids.
type feedKey struct {
	Kind string
	ID   string
	At   time.Time
}

// Feed: la actividad de una org, runs y deploys mezclados, de lo más nuevo a
// lo más viejo.
//
// **Se mezcla en el servidor, en una sola consulta** (`UNION ALL` + un solo
// `ORDER BY` + `LIMIT`): paginar dos tablas por separado y mezclar en el
// cliente no puede saber dónde cortar —la página de runs puede acabar en ayer
// y la de deploys en hace una semana— y repetiría o saltaría entradas entre
// páginas. El cursor es `(at, id)`, de conjunto: dos entradas en el mismo
// instante no se pierden.
//
// Un run «es de un servicio» cuando su repo es el del servicio y su workflow
// es el de build del servicio (o cualquiera, si el servicio no tiene workflow
// puesto). Se deriva aquí y no se guarda en la fila: dos servicios del mismo
// repo (staging y prod) ven el mismo run los dos.
func (r *ActivityRepository) Feed(orgID string, f domain.ActivityFilter) (domain.ActivityPage, error) {
	page := domain.ActivityPage{Items: []domain.ActivityEntry{}}
	limit := f.Limit
	if limit <= 0 {
		limit = domain.ActivityPageDefault
	}
	if limit > domain.ActivityPageMax {
		limit = domain.ActivityPageMax
	}

	runs := "SELECT 'run' AS kind, r.id, r.occurred_at AS at FROM workflow_runs r WHERE r.org_id = ?"
	runArgs := []any{orgID}
	deps := "SELECT 'deployment' AS kind, d.id, d.created_at AS at FROM deployments d JOIN deployables x ON x.id = d.deployable_id WHERE d.org_id = ?"
	depArgs := []any{orgID}
	if f.Repo != "" {
		runs += " AND LOWER(r.repo_full_name) = LOWER(?)"
		runArgs = append(runArgs, f.Repo)
		deps += " AND LOWER(x.repo_full_name) = LOWER(?)"
		depArgs = append(depArgs, f.Repo)
	}
	if f.DeployableID != "" {
		runs += ` AND EXISTS (SELECT 1 FROM deployables x WHERE x.id = ?
			AND x.repo_full_name <> '' AND LOWER(x.repo_full_name) = LOWER(r.repo_full_name)
			AND (x.build_workflow = '' OR r.path = '.github/workflows/' || x.build_workflow))`
		runArgs = append(runArgs, f.DeployableID)
		deps += " AND d.deployable_id = ?"
		depArgs = append(depArgs, f.DeployableID)
	}
	sql := "SELECT kind, id, at FROM (" + runs + " UNION ALL " + deps + ") u"
	args := append(runArgs, depArgs...)
	if !f.Before.IsZero() {
		sql += " WHERE (u.at, u.id) < (?, ?)"
		args = append(args, f.Before, f.BeforeID)
	}
	sql += " ORDER BY u.at DESC, u.id DESC LIMIT ?"
	args = append(args, limit+1)

	var keys []feedKey
	if err := r.db.Raw(sql, args...).Scan(&keys).Error; err != nil {
		return page, err
	}
	if len(keys) > limit {
		page.HasMore = true
		keys = keys[:limit]
	}
	if len(keys) == 0 {
		return page, nil
	}

	var runIDs, depIDs []string
	for _, k := range keys {
		if k.Kind == domain.ActivityKindRun {
			runIDs = append(runIDs, k.ID)
		} else {
			depIDs = append(depIDs, k.ID)
		}
	}
	runsByID := map[string]*domain.WorkflowRun{}
	if len(runIDs) > 0 {
		var rows []domain.WorkflowRun
		if err := r.db.Where("id IN ?", runIDs).Find(&rows).Error; err != nil {
			return page, err
		}
		for i := range rows {
			runsByID[rows[i].ID] = &rows[i]
		}
	}
	// Los deploys de la página y los que cuelgan de los runs de la página, en
	// una sola consulta.
	depsByID := map[string]*domain.ActivityDeployment{}
	depsByRun := map[string][]domain.ActivityDeployment{}
	if len(depIDs) > 0 || len(runIDs) > 0 {
		var rows []domain.ActivityDeployment
		q := r.db.Table("deployments d").
			Select(`d.id, d.created_at, d.updated_at, d.org_id, d.deployable_id, d.server_id, d.image,
				d.final_image, d.previous_image, d.requested_by, d.requested_by_user_id, d.status, d.error,
				d.started_at, d.finished_at, d.rollback_of_id, d.workflow_run_id,
				x.name AS deployable_name, x.environment AS deployable_env,
				(SELECT ` + nombreVisible + ` FROM users WHERE id = d.requested_by_user_id) AS requested_by_name`).
			Joins("JOIN deployables x ON x.id = d.deployable_id").
			Order("d.created_at DESC")
		switch {
		case len(depIDs) > 0 && len(runIDs) > 0:
			q = q.Where("d.id IN ? OR d.workflow_run_id IN ?", depIDs, runIDs)
		case len(depIDs) > 0:
			q = q.Where("d.id IN ?", depIDs)
		default:
			q = q.Where("d.workflow_run_id IN ?", runIDs)
		}
		if err := q.Scan(&rows).Error; err != nil {
			return page, err
		}
		for i := range rows {
			depsByID[rows[i].ID] = &rows[i]
			if rows[i].WorkflowRunID != "" {
				depsByRun[rows[i].WorkflowRunID] = append(depsByRun[rows[i].WorkflowRunID], rows[i])
			}
		}
	}

	for _, k := range keys {
		e := domain.ActivityEntry{Kind: k.Kind, At: k.At}
		if k.Kind == domain.ActivityKindRun {
			run, ok := runsByID[k.ID]
			if !ok {
				continue
			}
			e.Run, e.Deployments = run, depsByRun[run.ID]
		} else {
			dep, ok := depsByID[k.ID]
			if !ok {
				continue
			}
			e.Deployment = dep
		}
		page.Items = append(page.Items, e)
	}
	return page, nil
}

// FixRunTimes pone a cada intento su propia hora. Hasta el 7-oct-2026 se
// guardaba el `created_at` de la ejecución, el mismo en todos sus intentos, y
// el feed los mostraba empatados. Idempotente y barato: corre en cada
// arranque y sólo toca las filas que aún no la tienen.
func FixRunTimes(db *gorm.DB) error {
	return db.Exec(`UPDATE workflow_runs SET occurred_at = run_started_at
		WHERE run_started_at IS NOT NULL AND occurred_at <> run_started_at`).Error
}
