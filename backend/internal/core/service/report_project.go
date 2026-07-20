package service

import (
	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ReportProjectService struct {
	repo *repository.ReportProjectRepository
}

func NewReportProjectService(repo *repository.ReportProjectRepository) *ReportProjectService {
	return &ReportProjectService{repo: repo}
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

	plain, hash, err := repository.GenerateIngestKey()
	if err != nil {
		return nil, err
	}

	p := &domain.ReportProject{
		OrgID:            req.OrgID,
		Name:             req.Name,
		Slug:             slug,
		IngestKeyHash:    hash,
		AllowedOrigins:   domain.StringList(req.AllowedOrigins),
		RateLimitPerHour: defaultRateLimit(req.RateLimitPerHour),
		IsActive:         true,
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

func (s *ReportProjectService) List(orgIDs []string) ([]domain.ReportProjectResponse, error) {
	projects, err := s.repo.ListByOrgs(orgIDs)
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
	p.Name = req.Name
	p.AllowedOrigins = domain.StringList(req.AllowedOrigins)
	p.RateLimitPerHour = defaultRateLimit(req.RateLimitPerHour)
	if req.IsActive != nil {
		p.IsActive = *req.IsActive
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
		ID:               p.ID,
		OrgID:            p.OrgID,
		Name:             p.Name,
		Slug:             p.Slug,
		AllowedOrigins:   origins,
		RateLimitPerHour: p.RateLimitPerHour,
		IsActive:         p.IsActive,
		CreatedAt:        p.CreatedAt,
	}
}
