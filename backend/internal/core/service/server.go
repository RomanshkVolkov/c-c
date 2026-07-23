package service

import (
	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ServerService struct {
	repo *repository.ServerRepository
}

func NewServerService(repo *repository.ServerRepository) *ServerService {
	return &ServerService{repo: repo}
}

func (s *ServerService) Create(req domain.CreateServerRequest) (*domain.ServerResponse, error) {
	server := &domain.Server{
		OrgID:     req.OrgID,
		Name:      req.Name,
		Host:      req.Host,
		SSHPort:   req.SSHPort,
		SSHUser:   req.SSHUser,
		Type:      req.Type,
		AgentPort: req.AgentPort,
		Status:    "pending",
	}
	server.ID = uuid.NewString()

	if err := s.repo.Create(server); err != nil {
		return nil, err
	}

	return toResponse(server), nil
}

func (s *ServerService) List(orgIDs []string, superadmin bool) ([]domain.ServerResponse, error) {
	var servers []domain.Server
	var err error
	if superadmin {
		servers, err = s.repo.ListAll()
	} else {
		servers, err = s.repo.ListByOrgs(orgIDs)
	}
	if err != nil {
		return nil, err
	}
	result := make([]domain.ServerResponse, len(servers))
	for i, srv := range servers {
		result[i] = *toResponse(&srv)
	}
	return result, nil
}

// Find returns a single server (used for authorization before mutations).
func (s *ServerService) Find(id string) (*domain.ServerResponse, error) {
	srv, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	return toResponse(srv), nil
}

func (s *ServerService) Delete(id string) error {
	return s.repo.Delete(id)
}

func toResponse(s *domain.Server) *domain.ServerResponse {
	return &domain.ServerResponse{
		ID:        s.ID,
		OrgID:     s.OrgID,
		Name:      s.Name,
		Host:      s.Host,
		SSHPort:   s.SSHPort,
		SSHUser:   s.SSHUser,
		Type:      s.Type,
		AgentPort: s.AgentPort,
		Status:    s.Status,
	}
}
