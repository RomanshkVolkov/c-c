package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var ErrReportNotFound = errors.New("report not found")

type ReportRepository struct {
	db *gorm.DB
}

func NewReportRepository(db *gorm.DB) *ReportRepository {
	return &ReportRepository{db: db}
}

// CreateWithSeq assigns the next per-project folio (seq) and inserts the report
// in a single transaction so PROJ-123 numbering stays gap-consistent under
// normal load.
func (r *ReportRepository) CreateWithSeq(report *domain.Report) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var maxSeq int
		if err := tx.Model(&domain.Report{}).
			Where("project_id = ?", report.ProjectID).
			Select("COALESCE(MAX(seq), 0)").
			Scan(&maxSeq).Error; err != nil {
			return err
		}
		report.Seq = maxSeq + 1
		return tx.Create(report).Error
	})
}

// AddImages persists uploaded screenshots for a report (gallery when CommentID
// is nil).
func (r *ReportRepository) AddImages(images []domain.ReportImage) error {
	if len(images) == 0 {
		return nil
	}
	return r.db.Create(&images).Error
}

func (r *ReportRepository) FindByID(id string) (*domain.Report, error) {
	var report domain.Report
	if err := r.db.First(&report, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrReportNotFound
		}
		return nil, err
	}
	return &report, nil
}
