package service

import (
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// invitationTTL is how long a pending invitation stays acceptable.
const invitationTTL = 14 * 24 * time.Hour

type InvitationService struct {
	repo *repository.InvitationRepository
}

func NewInvitationService(repo *repository.InvitationRepository) *InvitationService {
	return &InvitationService{repo: repo}
}

// Create issues a pending invitation. Caller authorization (org admin or
// superadmin) is enforced in the handler.
func (s *InvitationService) Create(orgID, invitedUserID, inviterID string, role domain.OrgRole) error {
	inv := &domain.OrgInvitation{
		OrgID:           orgID,
		InvitedUserID:   invitedUserID,
		Role:            role,
		InvitedByUserID: inviterID,
		Status:          domain.InvitePending,
		ExpiresAt:       time.Now().Add(invitationTTL),
	}
	inv.ID = uuid.NewString()
	return s.repo.Create(inv)
}

func (s *InvitationService) ListForUser(userID string) ([]domain.InvitationResponse, error) {
	return s.repo.ListForUser(userID)
}

func (s *InvitationService) ListForOrg(orgID string) ([]domain.InvitationResponse, error) {
	return s.repo.ListForOrg(orgID)
}

// Accept verifies the invitation belongs to the caller, then joins them to the
// org. Returns ErrForbidden if the invitation is for someone else.
func (s *InvitationService) Accept(invitationID, callerID string) error {
	inv, err := s.repo.FindByID(invitationID)
	if err != nil {
		return err
	}
	if inv.InvitedUserID != callerID {
		return ErrForbidden
	}
	if !inv.ExpiresAt.IsZero() && inv.ExpiresAt.Before(time.Now()) {
		return repository.ErrInvitationNotFound // expired — treat as gone
	}
	return s.repo.Accept(inv)
}

// Decline verifies ownership then marks the invitation declined.
func (s *InvitationService) Decline(invitationID, callerID string) error {
	inv, err := s.repo.FindByID(invitationID)
	if err != nil {
		return err
	}
	if inv.InvitedUserID != callerID {
		return ErrForbidden
	}
	return s.repo.SetStatus(invitationID, domain.InviteDeclined)
}

// Revoke marks an invitation revoked. The handler verifies the caller admins
// the invitation's org (route is nested under the org). orgID guards against
// revoking an invitation from a different org via a mismatched URL.
func (s *InvitationService) Revoke(invitationID, orgID string) error {
	inv, err := s.repo.FindByID(invitationID)
	if err != nil {
		return err
	}
	if inv.OrgID != orgID {
		return repository.ErrInvitationNotFound
	}
	return s.repo.SetStatus(invitationID, domain.InviteRevoked)
}
