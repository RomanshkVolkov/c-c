package repository

import (
	"errors"
	"fmt"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var (
	ErrReportNotFound  = errors.New("report not found")
	ErrCommentNotFound = errors.New("comment not found")
	ErrImageNotFound   = errors.New("image not found")
)

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

// FindOpenByTitle returns an open (pending/in_progress) report of the project
// with the exact same title, if any — the dedup check for system reports.
func (r *ReportRepository) FindOpenByTitle(projectID, title string) (*domain.Report, error) {
	var report domain.Report
	err := r.db.
		Where("project_id = ? AND title = ? AND status IN ?",
			projectID, title, []domain.ReportStatus{domain.ReportPending, domain.ReportInProgress}).
		Order("created_at DESC").
		First(&report).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &report, nil
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

func (r *ReportRepository) Save(report *domain.Report) error {
	return r.db.Save(report).Error
}

// PurgeExpiredTelemetry clears telemetry blobs past their TTL without deleting
// the report (decision 4/7). Returns rows affected.
func (r *ReportRepository) PurgeExpiredTelemetry() (int64, error) {
	res := r.db.Model(&domain.Report{}).
		Where("telemetry_purge_at IS NOT NULL AND telemetry_purge_at < ? AND telemetry IS NOT NULL", time.Now()).
		Updates(map[string]any{"telemetry": nil, "telemetry_purge_at": nil})
	return res.RowsAffected, res.Error
}

// OrgIDForReport resolves the owning org of a report through its project
// (authorization lookups).
// EventTargetForReport resolves, in one query, everything an emitted event
// needs — the org for the live stream, and the project's webhook, if any.
func (r *ReportRepository) EventTargetForReport(reportID string) (*domain.ReportEventTarget, error) {
	var row struct {
		OrgID         string
		ProjectID     string
		Slug          string
		Seq           int
		ReporterID    string
		ReporterName  string
		WebhookURL    string
		WebhookSecret string
	}
	err := r.db.Raw(`
		SELECT p.org_id, p.id AS project_id, p.slug, rp.seq,
		       rp.reporter_id, rp.reporter_name,
		       p.webhook_url, p.webhook_secret
		FROM reports rp
		JOIN report_projects p ON p.id = rp.project_id
		WHERE rp.id = ? AND rp.deleted_at IS NULL
	`, reportID).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.OrgID == "" {
		return nil, ErrReportNotFound
	}
	return &domain.ReportEventTarget{
		OrgID:         row.OrgID,
		ProjectID:     row.ProjectID,
		Folio:         fmt.Sprintf("%s-%d", row.Slug, row.Seq),
		ReporterID:    row.ReporterID,
		ReporterName:  row.ReporterName,
		WebhookURL:    row.WebhookURL,
		WebhookSecret: row.WebhookSecret,
	}, nil
}

// ProjectIDForReport resolves which project a report belongs to, for the
// project-key authorization gate.
// UsernameByID resolves a display name for an assignee, empty when unset or
// unknown. Deliberately forgiving: a report whose assignee was removed should
// still open.
func (r *ReportRepository) UsernameByID(userID string) string {
	if userID == "" {
		return ""
	}
	var name string
	r.db.Raw(`SELECT username FROM users WHERE id = ?`, userID).Scan(&name)
	return name
}

func (r *ReportRepository) ProjectIDForReport(reportID string) (string, error) {
	var projectID string
	err := r.db.Raw(`
		SELECT rp.project_id FROM reports rp
		WHERE rp.id = ? AND rp.deleted_at IS NULL
	`, reportID).Scan(&projectID).Error
	if err != nil {
		return "", err
	}
	if projectID == "" {
		return "", ErrReportNotFound
	}
	return projectID, nil
}

func (r *ReportRepository) OrgIDForReport(reportID string) (string, error) {
	var orgID string
	err := r.db.Raw(`
		SELECT p.org_id FROM reports rp
		JOIN report_projects p ON p.id = rp.project_id
		WHERE rp.id = ? AND rp.deleted_at IS NULL
	`, reportID).Scan(&orgID).Error
	if err != nil {
		return "", err
	}
	if orgID == "" {
		return "", ErrReportNotFound
	}
	return orgID, nil
}

// ProjectForReport loads the report's project (slug for folios, org for authz).
func (r *ReportRepository) ProjectForReport(reportID string) (*domain.ReportProject, error) {
	var p domain.ReportProject
	err := r.db.Raw(`
		SELECT p.* FROM report_projects p
		JOIN reports rp ON rp.project_id = p.id
		WHERE rp.id = ?
	`, reportID).Scan(&p).Error
	if err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, ErrReportNotFound
	}
	return &p, nil
}

// List returns reports across the caller's orgs with filters + pagination.
// image_count counts ONLY the gallery (comment_id IS NULL) — portento gotcha
// fixed at the source.
func (r *ReportRepository) List(orgIDs []string, q domain.ReportListQuery, superadmin bool) (*domain.ReportListResult, error) {
	result := &domain.ReportListResult{Items: []domain.ReportListItem{}, Limit: q.Limit, Offset: q.Offset}
	if len(orgIDs) == 0 && !superadmin {
		return result, nil
	}

	filtered := func() *gorm.DB {
		db := r.db.Table("reports r").
			Joins("JOIN report_projects p ON p.id = r.project_id").
			Where("r.deleted_at IS NULL")
		if !superadmin { // superadmin sees reports across all orgs
			db = db.Where("p.org_id IN ?", orgIDs)
		}
		if q.ProjectID != "" {
			db = db.Where("r.project_id = ?", q.ProjectID)
		}
		if q.Status != "" {
			db = db.Where("r.status = ?", q.Status)
		}
		if q.Category != "" {
			db = db.Where("r.category = ?", q.Category)
		}
		if q.Priority != "" {
			db = db.Where("r.priority = ?", q.Priority)
		}
		if q.AssigneeID != "" {
			db = db.Where("r.assignee_user_id = ?", q.AssigneeID)
		}
		// Narrows within what the caller can already see — the org scope above
		// still applies, so this can't reach another tenant's reports.
		if q.ReporterID != "" {
			db = db.Where("r.reporter_id = ?", q.ReporterID)
		}
		if q.From != nil {
			db = db.Where("r.created_at >= ?", *q.From)
		}
		if q.To != nil {
			db = db.Where("r.created_at <= ?", *q.To)
		}
		return db
	}

	if err := filtered().Count(&result.Total).Error; err != nil {
		return nil, err
	}

	err := filtered().
		Select(`r.id, r.project_id, p.slug AS project_slug, p.name AS project_name,
			r.seq, r.title, r.status, r.category, r.priority, r.area,
			r.origin, r.reporter_name, r.reporter_email, r.reporter_id,
			r.assignee_user_id, u.username AS assignee_name,
			(SELECT COUNT(*) FROM report_images i
			   WHERE i.report_id = r.id AND i.comment_id IS NULL AND i.deleted_at IS NULL) AS image_count,
			(SELECT COUNT(*) FROM report_comments c
			   WHERE c.report_id = r.id AND c.deleted_at IS NULL) AS comment_count,
			r.created_at, r.updated_at, r.resolved_at`).
		Joins("LEFT JOIN users u ON u.id = r.assignee_user_id").
		Order("r.created_at DESC").
		Limit(q.Limit).Offset(q.Offset).
		Scan(&result.Items).Error
	if err != nil {
		return nil, err
	}
	for i := range result.Items {
		result.Items[i].Folio = fmt.Sprintf("%s-%d", result.Items[i].ProjectSlug, result.Items[i].Seq)
	}
	return result, nil
}

// ListImages returns all live images of a report (gallery + comment-inline).
func (r *ReportRepository) ListImages(reportID string) ([]domain.ReportImage, error) {
	var images []domain.ReportImage
	err := r.db.Where("report_id = ?", reportID).Order("created_at ASC").Find(&images).Error
	return images, err
}

// ListComments returns the comment thread with author usernames.
func (r *ReportRepository) ListComments(reportID string) ([]domain.ReportCommentResponse, error) {
	var out []domain.ReportCommentResponse
	err := r.db.Raw(`
		SELECT c.id, c.kind, c.author_user_id, u.username AS author_name,
		       c.author_label, c.body, c.created_at, c.updated_at
		FROM report_comments c
		LEFT JOIN users u ON u.id = c.author_user_id
		WHERE c.report_id = ? AND c.deleted_at IS NULL
		ORDER BY c.created_at ASC
	`, reportID).Scan(&out).Error
	return out, err
}

func (r *ReportRepository) CreateComment(c *domain.ReportComment) error {
	return r.db.Create(c).Error
}

// CountTeamCommentsSince counts replies from our side (kind=user, author set)
// newer than `since` — the reporter's unread count for one report.
//
// A tenant app replying through its project key has no author_user_id, only a
// label. Counting on the id alone would leave its replies out of the badge, so
// the reporter would never be told they had an answer.
func (r *ReportRepository) CountTeamCommentsSince(reportID string, since time.Time) (int64, error) {
	var n int64
	err := r.db.Model(&domain.ReportComment{}).
		Where("report_id = ? AND kind = ? AND (author_user_id IS NOT NULL OR author_label <> '') AND created_at > ? AND deleted_at IS NULL",
			reportID, domain.CommentKindUser, since).
		Count(&n).Error
	return n, err
}

func (r *ReportRepository) FindComment(reportID, commentID string) (*domain.ReportComment, error) {
	var c domain.ReportComment
	err := r.db.Where("id = ? AND report_id = ?", commentID, reportID).First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrCommentNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *ReportRepository) UpdateCommentBody(id, body string) error {
	return r.db.Model(&domain.ReportComment{}).Where("id = ?", id).Update("body", body).Error
}

// DeleteComment soft-deletes a comment and its inline images.
func (r *ReportRepository) DeleteComment(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("comment_id = ?", id).Delete(&domain.ReportImage{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.ReportComment{}, "id = ?", id).Error
	})
}

func (r *ReportRepository) FindImage(reportID, imageID string) (*domain.ReportImage, error) {
	var img domain.ReportImage
	err := r.db.Where("id = ? AND report_id = ?", imageID, reportID).First(&img).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrImageNotFound
	}
	if err != nil {
		return nil, err
	}
	return &img, nil
}

func (r *ReportRepository) DeleteImage(id string) error {
	return r.db.Delete(&domain.ReportImage{}, "id = ?", id).Error
}
