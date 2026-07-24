package service

import (
	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type IntegrationService struct {
	repo *repository.IntegrationRepository
}

func NewIntegrationService(repo *repository.IntegrationRepository) *IntegrationService {
	return &IntegrationService{repo: repo}
}

func toIntegrationResponse(it *domain.ServerIntegration) domain.IntegrationResponse {
	return domain.IntegrationResponse{
		ID:         it.ID,
		ServerID:   it.ServerID,
		Kind:       it.Kind,
		Name:       it.Name,
		URL:        it.URL,
		AuthMethod: it.AuthMethod,
		HasSecret:  len(it.Secret) > 0,
		Hidden:     it.Hidden,
		CreatedAt:  it.CreatedAt,
	}
}

func (s *IntegrationService) List(serverID string) ([]domain.IntegrationResponse, error) {
	items, err := s.repo.ListByServer(serverID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.IntegrationResponse, len(items))
	for i := range items {
		out[i] = toIntegrationResponse(&items[i])
	}
	return out, nil
}

func (s *IntegrationService) Create(serverID, orgID string, req domain.CreateIntegrationRequest) (*domain.IntegrationResponse, error) {
	authMethod := req.AuthMethod
	if authMethod == "" {
		authMethod = "none"
	}
	it := &domain.ServerIntegration{
		ServerID:   serverID,
		OrgID:      orgID,
		Kind:       req.Kind,
		Name:       req.Name,
		URL:        req.URL,
		AuthMethod: authMethod,
	}
	it.ID = uuid.NewString()
	if req.Secret != "" {
		enc, err := repository.EncryptTelemetry([]byte(req.Secret))
		if err != nil {
			return nil, err
		}
		it.Secret = enc
	}
	if err := s.repo.Create(it); err != nil {
		return nil, err
	}
	r := toIntegrationResponse(it)
	return &r, nil
}

func (s *IntegrationService) Update(id string, req domain.UpdateIntegrationRequest) error {
	fields := map[string]any{
		"name": req.Name,
		"url":  req.URL,
	}
	if req.AuthMethod != "" {
		fields["auth_method"] = req.AuthMethod
	}
	if req.Hidden != nil {
		fields["hidden"] = *req.Hidden
	}
	if req.Secret != nil {
		if *req.Secret == "" {
			fields["secret"] = nil
		} else {
			enc, err := repository.EncryptTelemetry([]byte(*req.Secret))
			if err != nil {
				return err
			}
			fields["secret"] = enc
		}
	}
	return s.repo.Update(id, fields)
}

func (s *IntegrationService) Delete(id string) error {
	return s.repo.Delete(id)
}

// Reveal decrypts the stored secret. Role-gated in the handler.
func (s *IntegrationService) Reveal(id string) (string, error) {
	it, err := s.repo.FindByID(id)
	if err != nil {
		return "", err
	}
	if len(it.Secret) == 0 {
		return "", nil
	}
	plain, err := repository.DecryptTelemetry(it.Secret)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// Find exposes the raw integration (for handler authorization: check org).
func (s *IntegrationService) Find(id string) (*domain.ServerIntegration, error) {
	return s.repo.FindByID(id)
}
