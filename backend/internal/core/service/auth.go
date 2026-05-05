package service

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type AuthService struct {
	repo *repository.AuthRepository
}

func NewAuthService(repo *repository.AuthRepository) *AuthService {
	return &AuthService{repo: repo}
}

func (s *AuthService) Login(req domain.LoginRequest) (*domain.AuthResponse, error) {
	user, err := s.repo.FindByUsername(req.Username)
	if err != nil {
		return nil, errors.New("invalid credentials")
	}

	match, err := repository.CompareHash(req.Password, user.Password)
	if err != nil || !match {
		return nil, errors.New("invalid credentials")
	}

	tokens, err := repository.GenerateTokens(user.ID, user.Username)
	if err != nil {
		return nil, err
	}

	return &domain.AuthResponse{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresIn:    time.Now().Add(60 * time.Minute).Unix(),
		Session: domain.Session{
			ID:       user.ID,
			Username: user.Username,
		},
	}, nil
}

// SearchUsers exposes username autocomplete for share dialogs.
func (s *AuthService) SearchUsers(query, excludeUserID string, limit int) ([]domain.UserSummary, error) {
	users, err := s.repo.SearchByUsername(query, excludeUserID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.UserSummary, len(users))
	for i, u := range users {
		out[i] = domain.UserSummary{ID: u.ID, Username: u.Username}
	}
	return out, nil
}

func (s *AuthService) RefreshToken(refreshToken string) (*domain.AuthRefreshResponse, error) {
	claims, err := repository.ValidateRefreshToken(refreshToken)
	if err != nil {
		return nil, err
	}

	user, err := s.repo.FindByID(claims.UserID)
	if err != nil {
		return nil, errors.New("user not found")
	}

	tokens, err := repository.GenerateTokens(user.ID, user.Username)
	if err != nil {
		return nil, err
	}

	return &domain.AuthRefreshResponse{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
	}, nil
}
