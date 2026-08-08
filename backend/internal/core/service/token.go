package service

import (
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// defaultTokenTTLDays is used when the caller doesn't pick one. -1 days means
// "never expires".
const defaultTokenTTLDays = 90

type TokenService struct {
	repo     *repository.TokenRepository
	authRepo *repository.AuthRepository
}

func NewTokenService(repo *repository.TokenRepository, authRepo *repository.AuthRepository) *TokenService {
	return &TokenService{repo: repo, authRepo: authRepo}
}

func toTokenResponse(t *domain.PersonalAccessToken) domain.TokenResponse {
	return domain.TokenResponse{
		ID:         t.ID,
		Name:       t.Name,
		Preview:    t.Preview,
		LastUsedAt: t.LastUsedAt,
		ExpiresAt:  t.ExpiresAt,
		CreatedAt:  t.CreatedAt,
		Scopes:     splitScopes(t.Scopes),
	}
}

// Mint creates a token for the user. Read-only unless the request asks for a
// scope we recognize. The plaintext is returned once.
func (s *TokenService) Mint(userID string, req domain.CreateTokenRequest) (*domain.CreateTokenResult, error) {
	plain, hash, err := repository.GeneratePAT()
	if err != nil {
		return nil, err
	}

	days := req.ExpiresInDays
	if days == 0 {
		days = defaultTokenTTLDays
	}
	var expiresAt *time.Time
	if days > 0 {
		t := time.Now().AddDate(0, 0, days)
		expiresAt = &t
	}

	t := &domain.PersonalAccessToken{
		UserID:    userID,
		Name:      req.Name,
		TokenHash: hash,
		Preview:   repository.PATPrefix + "…" + plain[len(plain)-4:],
		ExpiresAt: expiresAt,
		Scopes:    sanitizeScopes(req.Scopes),
	}
	t.ID = uuid.NewString()
	if err := s.repo.Create(t); err != nil {
		return nil, err
	}
	return &domain.CreateTokenResult{Token: toTokenResponse(t), Value: plain}, nil
}

func (s *TokenService) List(userID string) ([]domain.TokenResponse, error) {
	items, err := s.repo.ListByUser(userID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.TokenResponse, len(items))
	for i := range items {
		out[i] = toTokenResponse(&items[i])
	}
	return out, nil
}

// Update re-permissions a token in place. The secret never changes: what a
// credential may do and what proves it is the holder are different questions,
// and rotating the second to answer the first is what makes people over-grant
// on the first try.
//
// Unknown scopes are dropped here exactly as they are at mint — the same
// sanitizer, so a string that would read as "granted" to some future check can
// never be stored by either path.
func (s *TokenService) Update(id, userID string, req domain.UpdateTokenRequest) (*domain.TokenResponse, error) {
	fields := map[string]any{}
	if req.Name != nil {
		fields["name"] = strings.TrimSpace(*req.Name)
	}
	if req.Scopes != nil {
		fields["scopes"] = sanitizeScopes(*req.Scopes)
	}
	if err := s.repo.Update(id, userID, fields); err != nil {
		return nil, err
	}
	t, err := s.repo.FindByIDForUser(id, userID)
	if err != nil {
		return nil, err
	}
	// Read back rather than echo the request: sanitizeScopes may have dropped
	// something, and the caller should see what was actually stored.
	out := toTokenResponse(t)
	return &out, nil
}

func (s *TokenService) Revoke(id, userID string) error {
	return s.repo.Delete(id, userID)
}

// Authenticate resolves a plaintext PAT into claims. Memberships and the
// superadmin flag are read fresh from the DB (unlike a JWT, which can carry a
// stale snapshot), so revoking access takes effect on the next request.
// sanitizeScopes keeps only scopes we actually define. An unknown string in the
// request must never be persisted: it would read as "granted" to any future
// check that looks for it.
func sanitizeScopes(requested []string) string {
	var kept []string
	for _, sc := range requested {
		sc = strings.TrimSpace(sc)
		if domain.ValidScope(sc) && !slices.Contains(kept, sc) {
			kept = append(kept, sc)
		}
	}
	return strings.Join(kept, ",")
}

func (s *TokenService) Authenticate(plain string) (*domain.ClaimsJWT, error) {
	t, err := s.repo.FindActiveByHash(repository.HashPAT(plain))
	if err != nil {
		return nil, err
	}
	user, err := s.authRepo.FindByID(t.UserID)
	if err != nil {
		return nil, err
	}
	orgs, err := s.authRepo.OrgClaimsForUser(user.ID)
	if err != nil {
		return nil, err
	}
	s.repo.TouchLastUsed(t.ID, time.Now())

	return &domain.ClaimsJWT{
		UserID:     user.ID,
		Username:   user.Username,
		Superadmin: user.IsSuperadmin,
		Orgs:       orgs,
		Scopes:     splitScopes(t.Scopes),
	}, nil
}

func splitScopes(raw string) []string {
	if raw == "" {
		return nil
	}
	return strings.Split(raw, ",")
}
