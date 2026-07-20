package repository

import (
	"errors"

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

// Update persists the editable fields (name, origins, rate limit, active flag).
func (r *ReportProjectRepository) Update(p *domain.ReportProject) error {
	return r.db.Model(&domain.ReportProject{}).
		Where("id = ?", p.ID).
		Updates(map[string]any{
			"name":                p.Name,
			"allowed_origins":     p.AllowedOrigins,
			"rate_limit_per_hour": p.RateLimitPerHour,
			"is_active":           p.IsActive,
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
