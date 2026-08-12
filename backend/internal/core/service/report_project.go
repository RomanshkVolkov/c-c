package service

import (
	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ReportProjectService struct {
	repo    *repository.ReportProjectRepository
	orgRepo *repository.OrganizationRepository
}

func NewReportProjectService(repo *repository.ReportProjectRepository, orgRepo *repository.OrganizationRepository) *ReportProjectService {
	return &ReportProjectService{repo: repo, orgRepo: orgRepo}
}

// validateDefaultAssignee ensures the default assignee (when set) belongs to
// the project's org.
func (s *ReportProjectService) validateDefaultAssignee(orgID, userID string) error {
	if userID == "" {
		return nil
	}
	if _, err := s.orgRepo.GetMembership(orgID, userID); err != nil {
		return ErrAssigneeNotMember
	}
	return nil
}

// defaultReporterRateLimit mirrors portento's own anti-spam rule, which is where
// the number comes from: ten reports per person per hour.
func defaultReporterRateLimit(v int) int {
	if v <= 0 {
		return 10
	}
	return v
}

func defaultRateLimit(v int) int {
	if v <= 0 {
		return 20 // hereda el anti-spam de portento, configurable
	}
	return v
}

// Create mints a project plus a write-only ingest key. The plaintext key is
// returned exactly once; only its HMAC is stored.
func (s *ReportProjectService) Create(req domain.CreateReportProjectRequest) (*domain.CreateReportProjectResult, error) {
	slug := slugify(req.Slug)
	if slug == "" {
		slug = slugify(req.Name)
	}
	if slug == "" {
		slug = uuid.NewString()[:8]
	}

	if err := s.validateDefaultAssignee(req.OrgID, req.DefaultAssigneeUserID); err != nil {
		return nil, err
	}

	plain, hash, err := repository.GenerateIngestKey()
	if err != nil {
		return nil, err
	}

	// Native "app" projects have no browser Origin; ignore any origins sent.
	platform := req.Platform
	if platform == "" {
		platform = "web"
	}
	origins := req.AllowedOrigins
	if platform == "app" {
		origins = nil
	}

	p := &domain.ReportProject{
		OrgID:                       req.OrgID,
		Name:                        req.Name,
		Slug:                        slug,
		WebhookURL:                  req.WebhookURL,
		WebhookSecret:               req.WebhookSecret,
		Platform:                    platform,
		IngestKeyHash:               hash,
		AllowedOrigins:              domain.StringList(origins),
		RateLimitPerHour:            defaultRateLimit(req.RateLimitPerHour),
		RateLimitPerReporterPerHour: defaultReporterRateLimit(req.RateLimitPerReporterPerHour),
		IsActive:                    true,
	}
	if req.DefaultAssigneeUserID != "" {
		p.DefaultAssigneeUserID = &req.DefaultAssigneeUserID
	}
	p.ID = uuid.NewString()

	if err := s.repo.Create(p); err != nil {
		return nil, err
	}
	return &domain.CreateReportProjectResult{
		Project:   *toReportProjectResponse(p),
		IngestKey: plain,
	}, nil
}

func (s *ReportProjectService) List(orgIDs []string, superadmin bool) ([]domain.ReportProjectResponse, error) {
	var projects []domain.ReportProject
	var err error
	if superadmin {
		projects, err = s.repo.ListAll()
	} else {
		projects, err = s.repo.ListByOrgs(orgIDs)
	}
	if err != nil {
		return nil, err
	}
	out := make([]domain.ReportProjectResponse, len(projects))
	for i := range projects {
		out[i] = *toReportProjectResponse(&projects[i])
	}
	return out, nil
}

func (s *ReportProjectService) Find(id string) (*domain.ReportProject, error) {
	return s.repo.FindByID(id)
}

func (s *ReportProjectService) Update(id string, req domain.UpdateReportProjectRequest) (*domain.ReportProjectResponse, error) {
	p, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	if err := s.validateDefaultAssignee(p.OrgID, req.DefaultAssigneeUserID); err != nil {
		return nil, err
	}
	p.Name = req.Name
	p.WebhookURL = req.WebhookURL
	// Only replaced when a new one is sent: an edit that leaves the field blank
	// means "unchanged", not "wipe the secret and silently stop signing".
	if req.WebhookSecret != "" {
		p.WebhookSecret = req.WebhookSecret
	}
	if req.WebhookURL == "" {
		p.WebhookSecret = "" // clearing the endpoint retires its secret too
	}
	p.AllowedOrigins = domain.StringList(req.AllowedOrigins)
	p.RateLimitPerHour = defaultRateLimit(req.RateLimitPerHour)
	p.RateLimitPerReporterPerHour = defaultReporterRateLimit(req.RateLimitPerReporterPerHour)
	if req.IsActive != nil {
		p.IsActive = *req.IsActive
	}
	if req.DefaultAssigneeUserID == "" {
		p.DefaultAssigneeUserID = nil
	} else {
		p.DefaultAssigneeUserID = &req.DefaultAssigneeUserID
	}
	if err := s.repo.Update(p); err != nil {
		return nil, err
	}
	return toReportProjectResponse(p), nil
}

func (s *ReportProjectService) Delete(id string) error {
	return s.repo.Delete(id)
}

// RotateKey issues a fresh ingest key (invalidates the previous one) and returns
// the new plaintext once.
func (s *ReportProjectService) RotateKey(id string) (string, error) {
	p, err := s.repo.FindByID(id)
	if err != nil {
		return "", err
	}
	plain, hash, err := repository.GenerateIngestKey()
	if err != nil {
		return "", err
	}
	p.IngestKeyHash = hash
	if err := s.repo.RotateKey(p.ID, hash); err != nil {
		return "", err
	}
	return plain, nil
}

func toReportProjectResponse(p *domain.ReportProject) *domain.ReportProjectResponse {
	origins := []string(p.AllowedOrigins)
	if origins == nil {
		origins = []string{}
	}
	return &domain.ReportProjectResponse{
		ID:                          p.ID,
		OrgID:                       p.OrgID,
		Name:                        p.Name,
		Slug:                        p.Slug,
		Platform:                    p.Platform,
		AllowedOrigins:              origins,
		RateLimitPerHour:            p.RateLimitPerHour,
		RateLimitPerReporterPerHour: p.RateLimitPerReporterPerHour,
		IsActive:                    p.IsActive,
		DefaultAssigneeUserID:       p.DefaultAssigneeUserID,
		ListID:                      p.ListID,
		WebhookURL:                  p.WebhookURL,
		// The secret is never returned — only whether one exists, which is all
		// the console needs to show "signed" instead of "unsigned".
		WebhookConfigured: p.WebhookSecret != "",
		CreatedAt:         p.CreatedAt,
	}
}
