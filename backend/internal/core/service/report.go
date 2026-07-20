package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ErrImagesUnavailable means the report carried screenshots but image-service is
// not configured/reachable, so none could be stored.
var ErrImagesUnavailable = errors.New("image storage unavailable")

type ReportService struct {
	repo    *repository.ReportRepository
	orgRepo *repository.OrganizationRepository
	images  *imageservice.Client
}

func NewReportService(repo *repository.ReportRepository, orgRepo *repository.OrganizationRepository, images *imageservice.Client) *ReportService {
	return &ReportService{repo: repo, orgRepo: orgRepo, images: images}
}

// Ingest creates a report for a project and forwards any screenshots to
// image-service (the web client never touches image-service or S3). The report
// row is created first so a screenshot-upload hiccup never loses the report.
func (s *ReportService) Ingest(ctx context.Context, project *domain.ReportProject, in domain.IngestReportInput) (*domain.IngestReportResult, error) {
	if len(in.Images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}

	report := &domain.Report{
		ProjectID:     project.ID,
		Title:         in.Title,
		Description:   in.Description,
		Status:        domain.ReportPending,
		URL:           in.URL,
		UserAgent:     in.UserAgent,
		Viewport:      in.Viewport,
		ReporterName:  in.ReporterName,
		ReporterEmail: in.ReporterEmail,
	}
	report.ID = uuid.NewString()
	if err := s.repo.CreateWithSeq(report); err != nil {
		return nil, err
	}

	uploaded := 0
	if len(in.Images) > 0 {
		folder := s.storageFolder(project, report.ID)
		var persisted []domain.ReportImage
		var lastErr error
		for _, img := range in.Images {
			res, err := s.images.UploadImage(ctx, img.FileName, img.ContentType, img.Data, folder)
			if err != nil {
				lastErr = err
				continue
			}
			ri := domain.ReportImage{ReportID: report.ID, Path: res.Key, FileName: img.FileName}
			ri.ID = uuid.NewString()
			persisted = append(persisted, ri)
		}
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
		uploaded = len(persisted)
		// Surface a total image-service outage; partial success is tolerated.
		if uploaded == 0 && lastErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
		}
	}

	return &domain.IngestReportResult{
		ID:     report.ID,
		Seq:    report.Seq,
		Folio:  fmt.Sprintf("%s-%d", project.Slug, report.Seq),
		Images: uploaded,
	}, nil
}

// storageFolder builds the private-bucket prefix: org/<slug>/project/<slug>/<reportID>.
func (s *ReportService) storageFolder(project *domain.ReportProject, reportID string) string {
	orgSlug, _ := s.orgRepo.SlugByID(project.OrgID)
	if orgSlug == "" {
		orgSlug = project.OrgID
	}
	return fmt.Sprintf("org/%s/project/%s/%s", orgSlug, project.Slug, reportID)
}
