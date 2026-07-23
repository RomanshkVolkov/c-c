package service

import (
	"errors"
	"time"

	"github.com/google/uuid"
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

	orgs, err := s.repo.OrgClaimsForUser(user.ID)
	if err != nil {
		return nil, err
	}

	tokens, err := repository.GenerateTokens(user.ID, user.Username, user.IsSuperadmin, orgs)
	if err != nil {
		return nil, err
	}

	return &domain.AuthResponse{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresIn:    time.Now().Add(60 * time.Minute).Unix(),
		Session: domain.Session{
			ID:         user.ID,
			Username:   user.Username,
			Superadmin: user.IsSuperadmin,
		},
	}, nil
}

func toUserResponse(u domain.User) domain.UserResponse {
	return domain.UserResponse{
		ID:           u.ID,
		Username:     u.Username,
		Email:        u.Email,
		Name:         u.Name,
		IsSuperadmin: u.IsSuperadmin,
		CreatedAt:    u.CreatedAt,
	}
}

// CreateUser provisions a new user (superadmin-only). New users start with zero
// org memberships — they only see what they create or are invited to.
func (s *AuthService) CreateUser(req domain.CreateUserRequest) (*domain.UserResponse, error) {
	hashed, err := repository.HashPassword(req.Password)
	if err != nil {
		return nil, err
	}
	u := domain.User{
		Username:     req.Username,
		Password:     hashed,
		Email:        req.Email,
		Name:         req.Name,
		IsSuperadmin: req.IsSuperadmin,
	}
	u.ID = uuid.NewString()
	if err := s.repo.CreateUser(&u); err != nil {
		return nil, err
	}
	r := toUserResponse(u)
	return &r, nil
}

func (s *AuthService) ListUsers() ([]domain.UserResponse, error) {
	users, err := s.repo.ListUsers()
	if err != nil {
		return nil, err
	}
	out := make([]domain.UserResponse, len(users))
	for i, u := range users {
		out[i] = toUserResponse(u)
	}
	return out, nil
}

// UpdateUser patches a user's profile / password / superadmin flag.
func (s *AuthService) UpdateUser(id string, req domain.UpdateUserRequest) error {
	fields := map[string]any{}
	if req.Password != "" {
		hashed, err := repository.HashPassword(req.Password)
		if err != nil {
			return err
		}
		fields["password"] = hashed
	}
	if req.Email != nil {
		fields["email"] = *req.Email
	}
	if req.Name != nil {
		fields["name"] = *req.Name
	}
	if req.IsSuperadmin != nil {
		fields["is_superadmin"] = *req.IsSuperadmin
	}
	return s.repo.UpdateUser(id, fields)
}

func (s *AuthService) DeleteUser(id string) error {
	return s.repo.DeleteUser(id)
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

	orgs, err := s.repo.OrgClaimsForUser(user.ID)
	if err != nil {
		return nil, err
	}

	tokens, err := repository.GenerateTokens(user.ID, user.Username, user.IsSuperadmin, orgs)
	if err != nil {
		return nil, err
	}

	return &domain.AuthRefreshResponse{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
	}, nil
}
