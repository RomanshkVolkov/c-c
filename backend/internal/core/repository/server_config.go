package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrServerTemplateNotFound = errors.New("server-template-not-found")
	ErrConfigVersionNotFound  = errors.New("config-version-not-found")
	ErrTemplateNameTaken      = errors.New("server-template-name-taken")
)

// ServerConfigRepository: las plantillas de servidor y las versiones de la
// config de cada uno. Todo es append-only: una versión no se edita ni se
// borra, se guarda otra.
type ServerConfigRepository struct{ db *gorm.DB }

func NewServerConfigRepository(db *gorm.DB) *ServerConfigRepository {
	return &ServerConfigRepository{db: db}
}

// ─── Config de un servidor ────────────────────────────────────────────────────

// SaveConfig numera y guarda una versión nueva. El número sale de la misma
// transacción que bloquea la fila del servidor: dos guardados a la vez salen
// 4 y 5, no dos 4 (el índice único lo rechazaría y uno se perdería).
func (r *ServerConfigRepository) SaveConfig(v *domain.ServerConfigVersion) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var srv domain.Server
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&srv, "id = ?", v.ServerID).Error; err != nil {
			return err
		}
		var last int
		if err := tx.Model(&domain.ServerConfigVersion{}).Where("server_id = ?", v.ServerID).
			Select("COALESCE(MAX(seq), 0)").Scan(&last).Error; err != nil {
			return err
		}
		v.Seq = last + 1
		return tx.Create(v).Error
	})
}

// Config: una versión (seq > 0) o la última (seq == 0). nil sin error si el
// servidor aún no tiene ninguna.
func (r *ServerConfigRepository) Config(serverID string, seq int) (*domain.ServerConfigVersion, error) {
	var v domain.ServerConfigVersion
	q := r.db.Where("server_id = ?", serverID)
	if seq > 0 {
		q = q.Where("seq = ?", seq)
	}
	err := q.Order("seq DESC").First(&v).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if seq > 0 {
			return nil, ErrConfigVersionNotFound
		}
		return nil, nil
	}
	return &v, err
}

// ConfigVersions: todas, la más nueva primero, con quién la guardó.
func (r *ServerConfigRepository) ConfigVersions(serverID string) ([]domain.ServerConfigVersionResponse, error) {
	var rows []domain.ServerConfigVersion
	if err := r.db.Where("server_id = ?", serverID).Order("seq DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	names, err := r.names(collect(rows, func(v domain.ServerConfigVersion) string { return v.CreatedBy }))
	if err != nil {
		return nil, err
	}
	out := make([]domain.ServerConfigVersionResponse, len(rows))
	for i, v := range rows {
		out[i] = domain.ServerConfigVersionResponse{ServerConfigVersion: v, CreatedByName: names[v.CreatedBy]}
	}
	return out, nil
}

// ─── Plantillas ───────────────────────────────────────────────────────────────

// CreateTemplate: la plantilla y su versión 1, juntas.
func (r *ServerConfigRepository) CreateTemplate(t *domain.ServerTemplate, v *domain.ServerTemplateVersion) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var n int64
		if err := tx.Model(&domain.ServerTemplate{}).Where("org_id = ? AND name = ?", t.OrgID, t.Name).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return ErrTemplateNameTaken
		}
		if err := tx.Create(t).Error; err != nil {
			return err
		}
		v.TemplateID, v.Seq = t.ID, 1
		return tx.Create(v).Error
	})
}

// SaveTemplateVersion numera como SaveConfig, bloqueando la plantilla.
func (r *ServerConfigRepository) SaveTemplateVersion(v *domain.ServerTemplateVersion) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var t domain.ServerTemplate
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&t, "id = ?", v.TemplateID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrServerTemplateNotFound
			}
			return err
		}
		var last int
		if err := tx.Model(&domain.ServerTemplateVersion{}).Where("template_id = ?", v.TemplateID).
			Select("COALESCE(MAX(seq), 0)").Scan(&last).Error; err != nil {
			return err
		}
		v.Seq = last + 1
		return tx.Create(v).Error
	})
}

// Template: la plantilla, sólo si es de esa org.
func (r *ServerConfigRepository) Template(orgID, id string) (*domain.ServerTemplate, error) {
	var t domain.ServerTemplate
	err := r.db.First(&t, "id = ? AND org_id = ?", id, orgID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrServerTemplateNotFound
	}
	return &t, err
}

// TemplateVersion: una versión (seq > 0) o la última.
func (r *ServerConfigRepository) TemplateVersion(templateID string, seq int) (*domain.ServerTemplateVersion, error) {
	var v domain.ServerTemplateVersion
	q := r.db.Where("template_id = ?", templateID)
	if seq > 0 {
		q = q.Where("seq = ?", seq)
	}
	err := q.Order("seq DESC").First(&v).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrServerTemplateNotFound
	}
	return &v, err
}

func (r *ServerConfigRepository) TemplateVersions(templateID string) ([]domain.ServerTemplateVersionResponse, error) {
	var rows []domain.ServerTemplateVersion
	if err := r.db.Where("template_id = ?", templateID).Order("seq DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return r.withNames(rows)
}

// Templates: las de la org, cada una con su última versión.
func (r *ServerConfigRepository) Templates(orgID string) ([]domain.ServerTemplateResponse, error) {
	var ts []domain.ServerTemplate
	if err := r.db.Where("org_id = ?", orgID).Order("name").Find(&ts).Error; err != nil {
		return nil, err
	}
	out := make([]domain.ServerTemplateResponse, 0, len(ts))
	for _, t := range ts {
		v, err := r.TemplateVersion(t.ID, 0)
		if err != nil && !errors.Is(err, ErrServerTemplateNotFound) {
			return nil, err
		}
		resp := domain.ServerTemplateResponse{ServerTemplate: t}
		if v != nil {
			withName, err := r.withNames([]domain.ServerTemplateVersion{*v})
			if err != nil {
				return nil, err
			}
			resp.Current = &withName[0]
		}
		out = append(out, resp)
	}
	return out, nil
}

func (r *ServerConfigRepository) withNames(rows []domain.ServerTemplateVersion) ([]domain.ServerTemplateVersionResponse, error) {
	names, err := r.names(collect(rows, func(v domain.ServerTemplateVersion) string { return v.CreatedBy }))
	if err != nil {
		return nil, err
	}
	out := make([]domain.ServerTemplateVersionResponse, len(rows))
	for i, v := range rows {
		out[i] = domain.ServerTemplateVersionResponse{ServerTemplateVersion: v, CreatedByName: names[v.CreatedBy]}
	}
	return out, nil
}

// names: id → nombre para enseñar (`nombreVisible`, nunca el username a mano).
func (r *ServerConfigRepository) names(ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct{ ID, Name string }
	if err := r.db.Table("users").Select("id, "+nombreVisible+" AS name").Where("id IN ?", ids).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, u := range rows {
		out[u.ID] = u.Name
	}
	return out, nil
}

func collect[T any](rows []T, key func(T) string) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range rows {
		if k := key(r); k != "" && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}
