package service

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrLastSuperadmin = errors.New("cannot remove the last superadmin")
	ErrLastOrgAdmin   = errors.New("user is the only admin of an organization; reassign first")
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
			ID:                 user.ID,
			Username:           user.Username,
			Email:              user.Email,
			Superadmin:         user.IsSuperadmin,
			MustChangePassword: user.MustChangePassword,
		},
	}, nil
}

// Me returns a fresh session from the DB (not the token) so late-changing flags
// like mustChangePassword / superadmin reflect immediately after an update.
func (s *AuthService) Me(userID string) (*domain.Session, error) {
	user, err := s.repo.FindByID(userID)
	if err != nil {
		return nil, err
	}
	return &domain.Session{
		ID:                 user.ID,
		Email:              user.Email,
		Username:           user.Username,
		Superadmin:         user.IsSuperadmin,
		MustChangePassword: user.MustChangePassword,
	}, nil
}

// ChangePassword verifies the caller's current password and sets a new one,
// clearing the must-change flag. Used both for the forced first-login change
// and voluntary changes.
func (s *AuthService) ChangePassword(userID, current, next string) error {
	user, err := s.repo.FindByID(userID)
	if err != nil {
		return err
	}
	match, err := repository.CompareHash(current, user.Password)
	if err != nil || !match {
		return errors.New("current password is incorrect")
	}
	hashed, err := repository.HashPassword(next)
	if err != nil {
		return err
	}
	return s.repo.UpdateUser(userID, map[string]any{
		"password":             hashed,
		"must_change_password": false,
	})
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
		// Admin-provisioned password → user must set their own on first login.
		MustChangePassword: true,
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
		// An admin reset forces the user to choose their own again.
		fields["must_change_password"] = true
	}
	if req.Email != nil {
		fields["email"] = *req.Email
	}
	if req.Name != nil {
		fields["name"] = *req.Name
	}
	if req.IsSuperadmin != nil {
		// Block demoting the last superadmin (would lock out platform admin).
		if !*req.IsSuperadmin {
			if err := s.guardLastSuperadmin(id); err != nil {
				return err
			}
		}
		fields["is_superadmin"] = *req.IsSuperadmin
	}
	return s.repo.UpdateUser(id, fields)
}

func (s *AuthService) DeleteUser(id string) error {
	if err := s.guardLastSuperadmin(id); err != nil {
		return err
	}
	sole, err := s.repo.SoleAdminOrgCount(id)
	if err != nil {
		return err
	}
	if sole > 0 {
		return ErrLastOrgAdmin
	}
	return s.repo.DeleteUser(id)
}

// guardLastSuperadmin returns ErrLastSuperadmin if the target is currently a
// superadmin and the only one left.
func (s *AuthService) guardLastSuperadmin(id string) error {
	u, err := s.repo.FindByID(id)
	if err != nil {
		return err
	}
	if !u.IsSuperadmin {
		return nil
	}
	n, err := s.repo.CountSuperadmins()
	if err != nil {
		return err
	}
	if n <= 1 {
		return ErrLastSuperadmin
	}
	return nil
}

// SearchUsers exposes username autocomplete for share dialogs.
func (s *AuthService) SearchUsers(query, excludeUserID string, limit int) ([]domain.UserSummary, error) {
	users, err := s.repo.SearchByUsername(query, excludeUserID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.UserSummary, len(users))
	for i, u := range users {
		out[i] = domain.UserSummary{ID: u.ID, Username: u.Username, LastSeenAt: u.LastSeenAt}
	}
	return out, nil
}

// SearchUsersInOrg: colleagues only. See the repository for why this is a
// separate call rather than an argument on the platform-wide search.
func (s *AuthService) SearchUsersInOrg(query, orgID, excludeUserID string, limit int) ([]domain.UserSummary, error) {
	users, err := s.repo.SearchUsersInOrg(query, orgID, excludeUserID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.UserSummary, len(users))
	for i, u := range users {
		out[i] = domain.UserSummary{ID: u.ID, Username: u.Username, LastSeenAt: u.LastSeenAt}
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
