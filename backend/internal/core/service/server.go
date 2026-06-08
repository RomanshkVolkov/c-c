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

func (s *ServerService) List() ([]domain.ServerResponse, error) {
	servers, err := s.repo.List()
	if err != nil {
		return nil, err
	}
	result := make([]domain.ServerResponse, len(servers))
	for i, srv := range servers {
		result[i] = *toResponse(&srv)
	}
	return result, nil
}

func (s *ServerService) Delete(id string) error {
	return s.repo.Delete(id)
}

func toResponse(s *domain.Server) *domain.ServerResponse {
	return &domain.ServerResponse{
		ID:        s.ID,
		Name:      s.Name,
		Host:      s.Host,
		SSHPort:   s.SSHPort,
		SSHUser:   s.SSHUser,
		Type:      s.Type,
		AgentPort: s.AgentPort,
		Status:    s.Status,
	}
}
