package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// imageURLTTL is how long a signed image proxy URL stays valid. Short-lived so
// a leaked URL is useless quickly; the app refetches the detail to renew.
const imageURLTTL = 10 * time.Minute

// telemetryTTL is the retention window for the encrypted telemetry blob; a purge
// job clears it after this without deleting the report (decision 4/7).
const telemetryTTL = 45 * 24 * time.Hour

// buildTelemetryBlob combines the widget's telemetry/snapshot/context JSON into
// one object and re-applies server-side redaction (defense in depth). Returns
// nil when nothing was sent.
func buildTelemetryBlob(in domain.IngestReportInput) []byte {
	if in.TelemetryJSON == "" && in.SnapshotJSON == "" && in.ContextJSON == "" {
		return nil
	}
	raw := func(s string) json.RawMessage {
		if s == "" {
			return nil
		}
		if !json.Valid([]byte(s)) {
			return nil
		}
		return json.RawMessage(repository.RedactSensitive(s))
	}
	combined := map[string]json.RawMessage{}
	if v := raw(in.TelemetryJSON); v != nil {
		combined["telemetry"] = v
	}
	if v := raw(in.SnapshotJSON); v != nil {
		combined["snapshot"] = v
	}
	if v := raw(in.ContextJSON); v != nil {
		combined["context"] = v
	}
	if len(combined) == 0 {
		return nil
	}
	blob, err := json.Marshal(combined)
	if err != nil {
		return nil
	}
	return blob
}

// signedImageURL builds the short-lived HMAC-signed proxy URL for an image.
func signedImageURL(reportID, imageID string) string {
	exp := time.Now().Add(imageURLTTL).Unix()
	sig := repository.SignImage(reportID, imageID, exp)
	return fmt.Sprintf("/api/v1/reports/%s/images/%s?exp=%d&sig=%s", reportID, imageID, exp, sig)
}

var (
	// ErrImagesUnavailable means the report carried screenshots but image-service
	// is not configured/reachable, so none could be stored.
	ErrImagesUnavailable = errors.New("image storage unavailable")
	ErrInvalidTransition = errors.New("invalid status transition")
	ErrAssigneeNotMember = errors.New("assignee is not a member of the organization")
	ErrCommentImmutable  = errors.New("system comments are immutable")
	ErrNotCommentAuthor  = errors.New("only the author can modify this comment")
	ErrEmptyComment      = errors.New("comment needs a body or at least one image")
)

type ReportService struct {
	repo     *repository.ReportRepository
	orgRepo  *repository.OrganizationRepository
	authRepo *repository.AuthRepository
	images   *imageservice.Client
	hub      *events.Hub
}

func NewReportService(
	repo *repository.ReportRepository,
	orgRepo *repository.OrganizationRepository,
	authRepo *repository.AuthRepository,
	images *imageservice.Client,
	hub *events.Hub,
) *ReportService {
	return &ReportService{repo: repo, orgRepo: orgRepo, authRepo: authRepo, images: images, hub: hub}
}

// emit publishes a report event scoped to the report's org (best-effort; a
// lookup failure just skips the notification).
func (s *ReportService) emit(eventType, reportID string, data map[string]any) {
	orgID, err := s.repo.OrgIDForReport(reportID)
	if err != nil {
		return
	}
	s.hub.Publish(events.Event{Type: eventType, OrgID: orgID, Data: data})
}

// ─── Ingest (public) ──────────────────────────────────────────────────────────

// Ingest creates a report for a project and forwards any screenshots to
// image-service (the web client never touches image-service or S3). The report
// row is created first so a screenshot-upload hiccup never loses the report.
//
// System-origin reports dedup by title against open reports of the same project
// (portento's createSystemBugTicket behavior) so retries don't flood the board.
func (s *ReportService) Ingest(ctx context.Context, project *domain.ReportProject, in domain.IngestReportInput) (*domain.IngestReportResult, error) {
	if len(in.Images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}

	origin := in.Origin
	if origin != "system" {
		origin = "user"
	}

	if origin == "system" {
		existing, err := s.repo.FindOpenByTitle(project.ID, in.Title)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return &domain.IngestReportResult{
				ID:      existing.ID,
				Seq:     existing.Seq,
				Folio:   fmt.Sprintf("%s-%d", project.Slug, existing.Seq),
				Deduped: true,
			}, nil
		}
	}

	report := &domain.Report{
		ProjectID:     project.ID,
		Title:         in.Title,
		Description:   in.Description,
		Status:        domain.ReportPending,
		Origin:        origin,
		URL:           in.URL,
		UserAgent:     in.UserAgent,
		Viewport:      in.Viewport,
		ReporterName:  in.ReporterName,
		ReporterEmail: in.ReporterEmail,
		ReporterID:    in.ReporterID,
		// Auto-assignment: reports are born assigned to the project's default
		// agent when configured (portento's DEFAULT_ASSIGNEE_ID).
		AssigneeUserID: project.DefaultAssigneeUserID,
	}
	report.ID = uuid.NewString()

	// Encrypt telemetry/snapshot/context at rest (decision 4/7). Skipped when no
	// KEK is configured; a telemetry hiccup never blocks the report.
	if blob := buildTelemetryBlob(in); blob != nil && repository.TelemetryEncryptionEnabled() {
		if enc, err := repository.EncryptTelemetry(blob); err == nil {
			report.Telemetry = enc
			purge := time.Now().Add(telemetryTTL)
			report.TelemetryPurgeAt = &purge
		}
	}

	if err := s.repo.CreateWithSeq(report); err != nil {
		return nil, err
	}

	uploaded := 0
	if len(in.Images) > 0 {
		folder := s.storageFolder(project, report.ID)
		persisted, lastErr := s.uploadImages(ctx, report.ID, nil, in.Images, folder)
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
		uploaded = len(persisted)
		// Surface a total image-service outage; partial success is tolerated.
		if uploaded == 0 && lastErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
		}
	}

	folio := fmt.Sprintf("%s-%d", project.Slug, report.Seq)
	s.hub.Publish(events.Event{Type: "report:new", OrgID: project.OrgID, Data: map[string]any{
		"reportId": report.ID, "projectId": project.ID, "folio": folio, "title": report.Title,
	}})

	return &domain.IngestReportResult{
		ID:     report.ID,
		Seq:    report.Seq,
		Folio:  folio,
		Images: uploaded,
		Token:  repository.MintReportToken(report.ID),
	}, nil
}

// ReporterView returns the reporter's own view of a report (status + thread),
// omitting internal fields. Caller must already be authorized by report token.
func (s *ReportService) ReporterView(reportID string) (*domain.ReporterReportView, error) {
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}
	project, err := s.repo.ProjectForReport(reportID)
	if err != nil {
		return nil, err
	}
	images, err := s.repo.ListImages(reportID)
	if err != nil {
		return nil, err
	}
	comments, err := s.repo.ListComments(reportID)
	if err != nil {
		return nil, err
	}

	var gallery []domain.ReportImageResponse
	byComment := make(map[string][]domain.ReportImageResponse)
	for _, img := range images {
		res := domain.ReportImageResponse{ID: img.ID, FileName: img.FileName, URL: signedImageURL(reportID, img.ID), CreatedAt: img.CreatedAt}
		if img.CommentID == nil {
			gallery = append(gallery, res)
		} else {
			byComment[*img.CommentID] = append(byComment[*img.CommentID], res)
		}
	}
	if gallery == nil {
		gallery = []domain.ReportImageResponse{}
	}

	out := make([]domain.ReporterCommentView, 0, len(comments))
	for _, c := range comments {
		author := "team"
		if c.Kind == domain.CommentKindSystem {
			author = "system"
		} else if c.AuthorUserID == nil {
			author = "you" // reporter's own comment
		}
		out = append(out, domain.ReporterCommentView{
			Author:    author,
			Body:      c.Body,
			Images:    byComment[c.ID],
			CreatedAt: c.CreatedAt,
		})
	}

	return &domain.ReporterReportView{
		ID:          report.ID,
		Folio:       fmt.Sprintf("%s-%d", project.Slug, report.Seq),
		Title:       report.Title,
		Description: report.Description,
		Status:      report.Status,
		CreatedAt:   report.CreatedAt,
		UpdatedAt:   report.UpdatedAt,
		Images:      gallery,
		Comments:    out,
	}, nil
}

// ReporterComment adds a comment from the reporter (author nil = reporter, per
// the model) plus optional images, and notifies the console.
func (s *ReportService) ReporterComment(ctx context.Context, reportID, body string, images []domain.IngestImage) (*domain.ReporterReportView, error) {
	if len(images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}
	c := &domain.ReportComment{ReportID: reportID, Kind: domain.CommentKindUser, Body: body}
	c.ID = uuid.NewString()
	if err := s.repo.CreateComment(c); err != nil {
		return nil, err
	}
	if len(images) > 0 {
		project, err := s.repo.ProjectForReport(reportID)
		if err != nil {
			return nil, err
		}
		folder := s.storageFolder(project, reportID)
		var persisted []domain.ReportImage
		for _, img := range images {
			res, err := s.images.UploadImage(ctx, img.FileName, img.ContentType, img.Data, folder)
			if err != nil {
				continue
			}
			ri := domain.ReportImage{ReportID: reportID, CommentID: &c.ID, Path: res.Key, FileName: img.FileName}
			ri.ID = uuid.NewString()
			persisted = append(persisted, ri)
		}
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
	}
	s.emit("report:comment", reportID, map[string]any{"reportId": reportID, "commentId": c.ID, "from": "reporter"})
	return s.ReporterView(reportID)
}

// storageFolder builds the private-bucket prefix: org/<slug>/project/<slug>/<reportID>.
func (s *ReportService) storageFolder(project *domain.ReportProject, reportID string) string {
	orgSlug, _ := s.orgRepo.SlugByID(project.OrgID)
	if orgSlug == "" {
		orgSlug = project.OrgID
	}
	return fmt.Sprintf("org/%s/project/%s/%s", orgSlug, project.Slug, reportID)
}

// uploadImages pushes files to image-service and returns the rows to persist.
func (s *ReportService) uploadImages(ctx context.Context, reportID string, commentID *string, images []domain.IngestImage, folder string) ([]domain.ReportImage, error) {
	var persisted []domain.ReportImage
	var lastErr error
	for _, img := range images {
		res, err := s.images.UploadImage(ctx, img.FileName, img.ContentType, img.Data, folder)
		if err != nil {
			lastErr = err
			continue
		}
		ri := domain.ReportImage{ReportID: reportID, CommentID: commentID, Path: res.Key, FileName: img.FileName}
		ri.ID = uuid.NewString()
		persisted = append(persisted, ri)
	}
	return persisted, lastErr
}

// ─── Admin (console) ──────────────────────────────────────────────────────────

func (s *ReportService) List(orgIDs []string, q domain.ReportListQuery) (*domain.ReportListResult, error) {
	return s.repo.List(orgIDs, q)
}

// OrgIDForReport exposes the report→org resolution for handler authorization.
func (s *ReportService) OrgIDForReport(reportID string) (string, error) {
	return s.repo.OrgIDForReport(reportID)
}

// Detail assembles the full report view: gallery images + comment thread with
// inline images.
func (s *ReportService) Detail(reportID string) (*domain.ReportDetailResponse, error) {
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}
	project, err := s.repo.ProjectForReport(reportID)
	if err != nil {
		return nil, err
	}
	images, err := s.repo.ListImages(reportID)
	if err != nil {
		return nil, err
	}
	comments, err := s.repo.ListComments(reportID)
	if err != nil {
		return nil, err
	}

	var gallery []domain.ReportImageResponse
	byComment := make(map[string][]domain.ReportImageResponse)
	for _, img := range images {
		res := domain.ReportImageResponse{
			ID:        img.ID,
			CommentID: img.CommentID,
			FileName:  img.FileName,
			URL:       signedImageURL(reportID, img.ID),
			CreatedAt: img.CreatedAt,
		}
		if img.CommentID == nil {
			gallery = append(gallery, res)
		} else {
			byComment[*img.CommentID] = append(byComment[*img.CommentID], res)
		}
	}
	if gallery == nil {
		gallery = []domain.ReportImageResponse{}
	}
	for i := range comments {
		comments[i].Images = byComment[comments[i].ID]
	}
	if comments == nil {
		comments = []domain.ReportCommentResponse{}
	}

	// Decrypt telemetry for the console timeline (best-effort: a purged/absent
	// blob or missing KEK just yields no telemetry).
	var telemetry json.RawMessage
	if len(report.Telemetry) > 0 {
		if plain, err := repository.DecryptTelemetry(report.Telemetry); err == nil && json.Valid(plain) {
			telemetry = plain
		}
	}

	return &domain.ReportDetailResponse{
		ID:             report.ID,
		ProjectID:      report.ProjectID,
		ProjectSlug:    project.Slug,
		Seq:            report.Seq,
		Folio:          fmt.Sprintf("%s-%d", project.Slug, report.Seq),
		Title:          report.Title,
		Description:    report.Description,
		Status:         report.Status,
		Origin:         report.Origin,
		URL:            report.URL,
		UserAgent:      report.UserAgent,
		Viewport:       report.Viewport,
		ReporterName:   report.ReporterName,
		ReporterEmail:  report.ReporterEmail,
		ReporterID:     report.ReporterID,
		AssigneeUserID: report.AssigneeUserID,
		ResolvedAt:     report.ResolvedAt,
		CreatedAt:      report.CreatedAt,
		UpdatedAt:      report.UpdatedAt,
		Images:         gallery,
		Comments:       comments,
		Telemetry:      telemetry,
	}, nil
}

// Update applies a validated status transition and/or (un)assignment, leaving
// kind=system audit comments (portento behavior).
func (s *ReportService) Update(reportID string, req domain.UpdateReportRequest) (*domain.ReportDetailResponse, error) {
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}

	if req.Status != nil && *req.Status != report.Status {
		if !report.Status.CanTransitionTo(*req.Status) {
			return nil, fmt.Errorf("%w: %s → %s", ErrInvalidTransition, report.Status, *req.Status)
		}
		old := report.Status
		report.Status = *req.Status
		// resolved_at is (re)set on entering resolved and NOT cleared on reopen
		// (decision inherited from portento).
		if *req.Status == domain.ReportResolved {
			now := time.Now()
			report.ResolvedAt = &now
		}
		if err := s.systemComment(reportID, fmt.Sprintf("status: %s → %s", old, *req.Status)); err != nil {
			return nil, err
		}
	}

	if req.AssigneeUserID != nil {
		if *req.AssigneeUserID == "" {
			if report.AssigneeUserID != nil {
				report.AssigneeUserID = nil
				if err := s.systemComment(reportID, "unassigned"); err != nil {
					return nil, err
				}
			}
		} else {
			orgID, err := s.repo.OrgIDForReport(reportID)
			if err != nil {
				return nil, err
			}
			if _, err := s.orgRepo.GetMembership(orgID, *req.AssigneeUserID); err != nil {
				if errors.Is(err, repository.ErrMembershipNotFound) {
					return nil, ErrAssigneeNotMember
				}
				return nil, err
			}
			report.AssigneeUserID = req.AssigneeUserID
			name := *req.AssigneeUserID
			if u, err := s.authRepo.FindByID(*req.AssigneeUserID); err == nil {
				name = u.Username
			}
			if err := s.systemComment(reportID, "assigned to "+name); err != nil {
				return nil, err
			}
		}
	}

	if err := s.repo.Save(report); err != nil {
		return nil, err
	}
	if req.Status != nil {
		s.emit("report:status", reportID, map[string]any{"reportId": reportID, "status": report.Status})
	}
	return s.Detail(reportID)
}

// systemComment appends an immutable kind=system audit mark to the thread.
func (s *ReportService) systemComment(reportID, body string) error {
	c := &domain.ReportComment{ReportID: reportID, Kind: domain.CommentKindSystem, Body: body}
	c.ID = uuid.NewString()
	return s.repo.CreateComment(c)
}

// AddComment creates a user comment, optionally with inline images. Body may be
// empty when images are attached (portento behavior).
func (s *ReportService) AddComment(ctx context.Context, callerID, reportID, body string, images []domain.IngestImage) (*domain.ReportDetailResponse, error) {
	if body == "" && len(images) == 0 {
		return nil, ErrEmptyComment
	}
	if len(images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}
	if _, err := s.repo.FindByID(reportID); err != nil {
		return nil, err
	}

	c := &domain.ReportComment{ReportID: reportID, Kind: domain.CommentKindUser, AuthorUserID: &callerID, Body: body}
	c.ID = uuid.NewString()
	if err := s.repo.CreateComment(c); err != nil {
		return nil, err
	}

	if len(images) > 0 {
		project, err := s.repo.ProjectForReport(reportID)
		if err != nil {
			return nil, err
		}
		folder := s.storageFolder(project, reportID)
		persisted, lastErr := s.uploadImages(ctx, reportID, &c.ID, images, folder)
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
		if len(persisted) == 0 && lastErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
		}
	}
	s.emit("report:comment", reportID, map[string]any{"reportId": reportID, "commentId": c.ID})
	return s.Detail(reportID)
}

// EditComment updates the body of the caller's own user comment.
func (s *ReportService) EditComment(callerID, reportID, commentID, body string) error {
	c, err := s.repo.FindComment(reportID, commentID)
	if err != nil {
		return err
	}
	if c.Kind == domain.CommentKindSystem {
		return ErrCommentImmutable
	}
	if c.AuthorUserID == nil || *c.AuthorUserID != callerID {
		return ErrNotCommentAuthor
	}
	return s.repo.UpdateCommentBody(commentID, body)
}

// DeleteComment removes the caller's own user comment (and its inline images).
func (s *ReportService) DeleteComment(callerID, reportID, commentID string) error {
	c, err := s.repo.FindComment(reportID, commentID)
	if err != nil {
		return err
	}
	if c.Kind == domain.CommentKindSystem {
		return ErrCommentImmutable
	}
	if c.AuthorUserID == nil || *c.AuthorUserID != callerID {
		return ErrNotCommentAuthor
	}
	return s.repo.DeleteComment(commentID)
}

// AttachImages uploads screenshots to the report gallery, leaving a system
// audit comment (portento behavior).
func (s *ReportService) AttachImages(ctx context.Context, reportID string, images []domain.IngestImage) (*domain.ReportDetailResponse, error) {
	if len(images) == 0 {
		return nil, ErrEmptyComment
	}
	if !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}
	if _, err := s.repo.FindByID(reportID); err != nil {
		return nil, err
	}
	project, err := s.repo.ProjectForReport(reportID)
	if err != nil {
		return nil, err
	}
	folder := s.storageFolder(project, reportID)
	persisted, lastErr := s.uploadImages(ctx, reportID, nil, images, folder)
	if err := s.repo.AddImages(persisted); err != nil {
		return nil, err
	}
	if len(persisted) == 0 && lastErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
	}
	if err := s.systemComment(reportID, fmt.Sprintf("attached %d image(s)", len(persisted))); err != nil {
		return nil, err
	}
	s.emit("report:attachment", reportID, map[string]any{"reportId": reportID, "attached": len(persisted)})
	return s.Detail(reportID)
}

// DetachImage soft-deletes a gallery image, leaving a system audit comment.
func (s *ReportService) DetachImage(reportID, imageID string) error {
	img, err := s.repo.FindImage(reportID, imageID)
	if err != nil {
		return err
	}
	if err := s.repo.DeleteImage(img.ID); err != nil {
		return err
	}
	return s.systemComment(reportID, "removed image "+img.FileName)
}
