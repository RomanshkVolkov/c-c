package service

import (
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type GitHubService struct {
	repo *repository.ServerRepository
}

func NewGitHubService(repo *repository.ServerRepository) *GitHubService {
	return &GitHubService{repo: repo}
}

func (s *GitHubService) SetToken(serverID, token string) error {
	return repository.StoreGitHubToken(serverID, token)
}

func (s *GitHubService) DeleteToken(serverID string) error {
	return repository.DeleteGitHubToken(serverID)
}

func (s *GitHubService) TokenStatus(serverID string) domain.GitHubTokenStatus {
	return domain.GitHubTokenStatus{Configured: repository.IsGitHubTokenConfigured(serverID)}
}

func (s *GitHubService) ListSecrets(serverID, owner, repo string) (*domain.GitHubSecretsResponse, error) {
	return repository.ListGitHubSecrets(serverID, owner, repo)
}

func (s *GitHubService) ListVariables(serverID, owner, repo string) (*domain.GitHubVariablesResponse, error) {
	return repository.ListGitHubVariables(serverID, owner, repo)
}

func (s *GitHubService) SetSecret(serverID, owner, repo, name, value string) error {
	return repository.SetGitHubSecret(serverID, owner, repo, name, value)
}

func (s *GitHubService) SetVariable(serverID, owner, repo, name, value string, exists bool) error {
	return repository.SetGitHubVariable(serverID, owner, repo, name, value, exists)
}

func (s *GitHubService) DeleteSecret(serverID, owner, repo, name string) error {
	return repository.DeleteGitHubSecret(serverID, owner, repo, name)
}

func (s *GitHubService) DeleteVariable(serverID, owner, repo, name string) error {
	return repository.DeleteGitHubVariable(serverID, owner, repo, name)
}
