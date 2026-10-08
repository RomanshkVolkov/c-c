package repository

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var (
	ErrReportProjectNotFound  = errors.New("report project not found")
	ErrReportProjectSlugTaken = errors.New("report project slug already in use")
)

type ReportProjectRepository struct {
	db *gorm.DB
}

func NewReportProjectRepository(db *gorm.DB) *ReportProjectRepository {
	return &ReportProjectRepository{db: db}
}

func (r *ReportProjectRepository) Create(p *domain.ReportProject) error {
	var count int64
	if err := r.db.Model(&domain.ReportProject{}).Where("slug = ?", p.Slug).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrReportProjectSlugTaken
	}
	return r.db.Create(p).Error
}

func (r *ReportProjectRepository) FindByID(id string) (*domain.ReportProject, error) {
	var p domain.ReportProject
	if err := r.db.First(&p, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrReportProjectNotFound
		}
		return nil, err
	}
	return &p, nil
}

// ListByOrgs returns projects belonging to any of the given orgs.
func (r *ReportProjectRepository) ListByOrgs(orgIDs []string) ([]domain.ReportProject, error) {
	if len(orgIDs) == 0 {
		return []domain.ReportProject{}, nil
	}
	var out []domain.ReportProject
	err := r.db.Where("org_id IN ?", orgIDs).Order("created_at DESC").Find(&out).Error
	return out, err
}

// ListAll returns every project (superadmin scope).
func (r *ReportProjectRepository) ListAll() ([]domain.ReportProject, error) {
	var out []domain.ReportProject
	err := r.db.Order("created_at DESC").Find(&out).Error
	return out, err
}

// CountSinceByProject cuenta los reportes **recibidos** desde `desde`,
// agrupados por canal.
//
// Recibidos, no todos los del canal: una tarea escrita a mano dentro de una
// lista atada a un cliente también lleva su project_id (la hereda del espacio),
// y contarla haría que un canal que no recibe nada pareciera activo por el
// trabajo que hacemos nosotros. Eso lo distingue el origen, que sólo vale
// "internal" cuando la tarea nació aquí dentro.
//
// Una sola consulta y no una por proyecto: la pantalla de organización pinta
// todas las integraciones a la vez, y N+1 consultas ahí crecen con el número de
// clientes.
func (r *ReportProjectRepository) CountSinceByProject(desde time.Time) (map[string]int64, error) {
	type fila struct {
		ProjectID string
		N         int64
	}
	var filas []fila
	err := r.db.Model(&domain.Item{}).
		Select("project_id, COUNT(*) AS n").
		Where("project_id <> '' AND origin <> 'internal' AND created_at >= ?", desde).
		Group("project_id").Scan(&filas).Error
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(filas))
	for _, f := range filas {
		out[f.ProjectID] = f.N
	}
	return out, nil
}

// ListOrgID dice de qué organización es una lista, y devuelve "" si no existe.
//
// Hace falta para no dejar que un proyecto entregue sus reportes en el tablero
// de otra organización: sería filtrar el trabajo de un cliente a gente que no
// tiene nada que ver con él, y por una sola línea mal puesta en un formulario.
//
// Antes pedía también `l.deleted_at IS NULL`, y `task_lists` **no tiene esa
// columna** (`TaskList` no borra en blando). La consulta reventaba siempre, el
// error no se miraba, y la organización salía vacía: cambiar la bandeja desde
// Integraciones contestaba «esa lista es de otra organización» con cualquier
// lista, de cualquier organización (tarjeta #70). Por eso ahora el error vuelve
// al llamante: una consulta rota no puede hacerse pasar por una respuesta.
// → Guardián: `TestTheInboxGuardAsksTheListsOwnSpace`.
func (r *ReportProjectRepository) ListOrgID(listID string) (string, error) {
	var orgID string
	err := r.db.Raw(`
		SELECT COALESCE(s.org_id, '')
		FROM task_lists l
		JOIN task_spaces s ON s.id = l.space_id
		WHERE l.id = ?
	`, listID).Scan(&orgID).Error
	return orgID, err
}

// Update persists the editable fields.
func (r *ReportProjectRepository) Update(p *domain.ReportProject) error {
	// A mano: con un mapa, GORM no pasa el valor por el serializer de la
	// columna, y mandaría el struct tal cual.
	telemetry, err := json.Marshal(p.TelemetryConfig)
	if err != nil {
		return err
	}
	return r.db.Model(&domain.ReportProject{}).
		Where("id = ?", p.ID).
		// An explicit column list, so a new field on the struct is NOT persisted
		// until it's named here. Easy to forget — the service and the response
		// both look right while the row never changes.
		//
		// Y pasó justo eso con `list_id`: el servicio movía la bandeja, la
		// respuesta —hecha con el objeto en memoria— enseñaba la lista nueva, y
		// la fila no cambiaba. Los reportes seguían cayendo en la vieja sin que
		// nada lo dijera (#70).
		// → Guardián: `TestChangingTheInboxIsSaved`.
		Updates(map[string]any{
			"name":                             p.Name,
			"rate_limit_per_hour":              p.RateLimitPerHour,
			"rate_limit_per_reporter_per_hour": p.RateLimitPerReporterPerHour,
			"is_active":                        p.IsActive,
			"default_assignee_user_id":         p.DefaultAssigneeUserID,
			"webhook_url":                      p.WebhookURL,
			"webhook_secret":                   p.WebhookSecret,
			"list_id":                          p.ListID,
			"telemetry_config":                 string(telemetry),
		}).Error
}

func (r *ReportProjectRepository) Delete(id string) error {
	return r.db.Delete(&domain.ReportProject{}, "id = ?", id).Error
}

// RotateKey replaces the stored ingest key hash, revoking the previous key.
func (r *ReportProjectRepository) RotateKey(id string, hash []byte) error {
	return r.db.Model(&domain.ReportProject{}).
		Where("id = ?", id).
		Update("ingest_key_hash", hash).Error
}

// FindActiveByIngestKey resolves the project for a presented ingest key by
// HMAC lookup. Only active projects match. Used by the public ingest endpoint.
func (r *ReportProjectRepository) FindActiveByIngestKey(plainKey string) (*domain.ReportProject, error) {
	hash := HashIngestKey(plainKey)
	var p domain.ReportProject
	err := r.db.Where("ingest_key_hash = ? AND is_active = ?", hash, true).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrReportProjectNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}
