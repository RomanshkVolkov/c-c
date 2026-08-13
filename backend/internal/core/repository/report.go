package repository

import (
	"errors"
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
//
// Unscoped is load-bearing. The folio is the report's public name — what a
// reporter quotes and a tenant stores — so a number, once given out, is spent
// forever. GORM's default scope hides soft-deleted rows, so withdrawing the
// newest report of a project handed its number to the next one and two reports
// ended up called the same thing, with nothing to signal it.
func (r *ReportRepository) CreateWithSeq(report *domain.Report) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var maxSeq int
		if err := tx.Unscoped().Model(&domain.Report{}).
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
		FROM items rp
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
		Folio:         domain.Folio(row.Slug, row.Seq),
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
	// Retracted items are excluded here too, though today nothing can tell:
	// ProjectForReport already refuses them, so every path a tenant takes ends in
	// the same 404 with or without this clause. It stays because this is the
	// authorization gate rather than a lookup — the place where a second refusal
	// costs one condition and buys the case where the other filter is refactored
	// away by someone who checked only that the tests still pass.
	err := r.db.Raw(`
		SELECT rp.project_id FROM items rp
		WHERE rp.id = ? AND rp.deleted_at IS NULL AND rp.visibility <> ?
	`, reportID, domain.VisibilityInternal).Scan(&projectID).Error
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
		SELECT p.org_id FROM items rp
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
	// Same rule as the tenant's gate: a retracted item is not there for anyone
	// outside, and this is what the reporter's own view resolves through.
	err := r.db.Raw(`
		SELECT p.* FROM report_projects p
		JOIN items rp ON rp.project_id = p.id
		WHERE rp.id = ? AND rp.visibility <> ?
	`, reportID, domain.VisibilityInternal).Scan(&p).Error
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
		db := r.db.Table("items r").
			Joins("JOIN report_projects p ON p.id = r.project_id").
			Where("r.deleted_at IS NULL").
			// A retracted item keeps its channel so its folio stays spent, but
			// stops being listed. Without this the "take it back" button takes
			// nothing back.
			Where("r.visibility <> ?", domain.VisibilityInternal)
		if !superadmin { // superadmin sees reports across all orgs
			db = db.Where("p.org_id IN ?", orgIDs)
		}
		// Applied on top of the membership scope above, never instead of it —
		// so this narrows and can't be used to reach another tenant.
		if q.OrgID != "" {
			db = db.Where("p.org_id = ?", q.OrgID)
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
			// `none` only exists on the inside; the facade answers `medium` for it,
			// so a filter for medium that skipped those would contradict the list it
			// is filtering.
			if q.Priority == domain.ReportPriorityMedium {
				db = db.Where("r.priority IN ?", []string{"medium", "none"})
			} else {
				db = db.Where("r.priority = ?", q.Priority)
			}
		}
		if q.AssigneeID != "" {
			// Anyone on the card, not only the one the tenant is shown. "What is
			// Ana on?" is the question being asked, and answering it about only
			// the cards where she happens to be first hides real work.
			db = db.Where(`EXISTS (
				SELECT 1 FROM task_assignees x WHERE x.task_id = r.id AND x.user_id = ?
			)`, q.AssigneeID)
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
			a.user_id AS assignee_user_id, u.username AS assignee_name,
			(SELECT COUNT(*) FROM item_attachments i
			   WHERE i.item_id = r.id AND i.comment_id IS NULL AND i.deleted_at IS NULL) AS image_count,
			(SELECT COUNT(*) FROM item_comments c
			   WHERE c.item_id = r.id AND c.deleted_at IS NULL
			     AND c.visibility = 'public') AS comment_count,
			r.created_at, r.updated_at, r.resolved_at`).
		// The primary assignee, from the table the board writes too. There used to
		// be a column here as well, and the two never met.
		Joins(`LEFT JOIN LATERAL (
			SELECT user_id FROM task_assignees
			WHERE task_id = r.id ORDER BY "primary" DESC LIMIT 1
		) a ON true`).
		Joins("LEFT JOIN users u ON u.id = a.user_id").
		Order("r.created_at DESC").
		Limit(q.Limit).Offset(q.Offset).
		Scan(&result.Items).Error
	if err != nil {
		return nil, err
	}
	for i := range result.Items {
		result.Items[i].Folio = domain.Folio(result.Items[i].ProjectSlug, result.Items[i].Seq)
	}
	return result, nil
}

// ListImages returns all live images of a report (gallery + comment-inline).
func (r *ReportRepository) ListImages(reportID string) ([]domain.ReportImage, error) {
	var images []domain.ReportImage
	err := r.db.Where("item_id = ?", reportID).Order("created_at ASC").Find(&images).Error
	return images, err
}

// ListComments returns the comment thread with author usernames.
//
// insideCac is the only question that matters here, and it answers two things at
// once because they are the same thing: whether the reader is the team.
//
//   - A withdrawn comment stays part of the record the team can consult, and the
//     tenant and the reporter must not receive it — not even a gap where it was.
//   - An internal comment is a note between us. It never leaves: not to the
//     tenant's API, not to the reporter, not down the webhook, not into the
//     unread count. This is the one filter in the codebase whose failure is a
//     leak rather than a bug, which is why it lives in a single query instead of
//     being reapplied by each caller.
//
// The caller decides; see the two gates in report_admin.go.
func (r *ReportRepository) ListComments(reportID string, insideCac bool) ([]domain.ReportCommentResponse, error) {
	var out []domain.ReportCommentResponse
	err := r.db.Raw(`
		SELECT c.id, c.kind, c.author_user_id, u.username AS author_name,
		       c.author_project_id, p.name AS author_project_name,
		       c.author_external_id, c.author_external_name,
		       r.reporter_name, r.reporter_id, c.deleted_at,
		       c.body, c.created_at, c.updated_at
		FROM item_comments c
		JOIN items r ON r.id = c.item_id
		LEFT JOIN users u ON u.id = c.author_user_id
		LEFT JOIN report_projects p ON p.id = c.author_project_id
		WHERE c.item_id = ?
		  AND (c.deleted_at IS NULL OR ?)
		  AND (c.visibility = 'public' OR ?)
		ORDER BY c.created_at ASC
	`, reportID, insideCac, insideCac).Scan(&out).Error
	if err != nil {
		return nil, err
	}
	for i := range out {
		tagAuthor(&out[i])
	}
	return out, nil
}

// tagAuthor turns the scanned columns into the tagged author the API returns,
// and fills the flat fields the installed app still reads.
//
// One place decides what kind of author a comment has. Every reader that used to
// work it out from null-ness got it wrong at least once.
func tagAuthor(c *domain.ReportCommentResponse) {
	switch {
	case c.Kind == domain.CommentKindSystem:
		return // the comment's own kind already says it; no author to name
	case c.AuthorUserID != nil && *c.AuthorUserID != "":
		c.Author = &domain.CommentAuthor{
			Kind: domain.AuthorKindUser, Name: c.AuthorName, UserID: *c.AuthorUserID,
		}
	case c.AuthorProjectID != "":
		name := c.AuthorExternalName
		if name == "" {
			name = c.AuthorProjectName
		}
		// Whether this is the reporter speaking is a fact about *who wrote it*,
		// not about which endpoint it arrived through. The tenant already told us
		// the report's reporterId when it filed the report, and tells us the
		// author's id on every comment — both in its own id space, so comparing
		// them answers the question without the transport having an opinion.
		//
		// Deciding it by endpoint is what forced a tenant to choose between
		// attributing a reply correctly and being able to edit it: the reporter
		// route stores no project, so ownsComment can never match.
		if c.AuthorExternalID != "" && c.AuthorExternalID == c.ReporterID {
			c.Author = &domain.CommentAuthor{
				Kind: domain.AuthorKindReporter, Name: name,
				ExternalID: c.AuthorExternalID,
			}
			c.AuthorName = name
			break
		}
		c.Author = &domain.CommentAuthor{
			Kind: domain.AuthorKindTenant, Name: name,
			ProjectID: c.AuthorProjectID, ProjectName: c.AuthorProjectName,
			ExternalID: c.AuthorExternalID,
		}
		// What a build that predates `author` renders. It shows the tenant, which
		// is the safe half of the answer.
		c.AuthorLabel = c.AuthorProjectName
	default:
		// Name the reporter. The report has carried reporterName all along, so
		// printing the word "reporter" over five messages from a named person
		// was throwing away something we already knew.
		c.Author = &domain.CommentAuthor{Kind: domain.AuthorKindReporter, Name: c.ReporterName}
		// Also on the flat field, so a build that predates `author` shows the
		// name too instead of the placeholder.
		c.AuthorName = c.ReporterName
	}
}

func (r *ReportRepository) CreateComment(c *domain.ReportComment) error {
	return r.db.Create(c).Error
}

// CountTeamCommentsSince counts replies from our side (kind=user, author set)
// newer than `since` — the reporter's unread count for one report.
//
// A tenant app replying through its project key has no author_user_id, only the
// project it belongs to. Counting on the user id alone would leave its replies
// out of the badge, so the reporter would never be told they had an answer.
//
// But the tenant also relays the reporter's *own* comments, and those must not
// count: telling someone they have an unread reply, when the reply is the
// message they just wrote, is worse than not telling them anything.
func (r *ReportRepository) CountTeamCommentsSince(reportID string, since time.Time) (int64, error) {
	var n int64
	err := r.db.Table("item_comments c").
		Joins("JOIN items r ON r.id = c.item_id").
		Where("c.visibility = 'public'").
		Where("c.item_id = ? AND c.kind = ? AND c.created_at > ? AND c.deleted_at IS NULL",
			reportID, domain.CommentKindUser, since).
		Where("(c.author_user_id IS NOT NULL OR c.author_project_id IS NOT NULL)").
		Where("NOT (c.author_external_id <> '' AND c.author_external_id = r.reporter_id)").
		Count(&n).Error
	return n, err
}

func (r *ReportRepository) FindComment(reportID, commentID string) (*domain.ReportComment, error) {
	var c domain.ReportComment
	err := r.db.Where("id = ? AND item_id = ?", commentID, reportID).First(&c).Error
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
	err := r.db.Where("id = ? AND item_id = ?", imageID, reportID).First(&img).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrImageNotFound
	}
	if err != nil {
		return nil, err
	}
	return &img, nil
}

// ListCommentImages returns the images currently attached to one comment, which
// is what tells an edit whether an id it was asked to remove is actually its own.
func (r *ReportRepository) ListCommentImages(commentID string) ([]domain.ReportImage, error) {
	var out []domain.ReportImage
	err := r.db.Where("comment_id = ?", commentID).Order("created_at ASC").Find(&out).Error
	return out, err
}

// ApplyCommentEdit writes the whole edit in one transaction: the new text, the
// images that arrived and the ones that left. Separately they could half-apply,
// and a reply whose text says "see the screenshot" without the screenshot is
// worse than an edit that was refused.
func (r *ReportRepository) ApplyCommentEdit(commentID, body string, add []domain.ReportImage, removeIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&domain.ReportComment{}).
			Where("id = ?", commentID).Update("body", body).Error; err != nil {
			return err
		}
		if len(removeIDs) > 0 {
			if err := tx.Where("id IN ? AND comment_id = ?", removeIDs, commentID).
				Delete(&domain.ReportImage{}).Error; err != nil {
				return err
			}
		}
		if len(add) > 0 {
			if err := tx.Create(&add).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *ReportRepository) DeleteImage(id string) error {
	return r.db.Delete(&domain.ReportImage{}, "id = ?", id).Error
}
