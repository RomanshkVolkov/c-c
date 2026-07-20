package service

import (
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrForbidden = errors.New("forbidden")
	ErrLastAdmin = errors.New("cannot remove the last admin of an organization")
)

type OrganizationService struct {
	repo *repository.OrganizationRepository
}

func NewOrganizationService(repo *repository.OrganizationRepository) *OrganizationService {
	return &OrganizationService{repo: repo}
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	out := slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	return strings.Trim(out, "-")
}

// requireRole loads the caller's membership and enforces a minimum role.
// Returns ErrForbidden when the caller lacks membership or sufficient role.
func (s *OrganizationService) requireRole(orgID, userID string, min domain.OrgRole) (*domain.OrgMembership, error) {
	m, err := s.repo.GetMembership(orgID, userID)
	if errors.Is(err, repository.ErrMembershipNotFound) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if !roleAtLeast(m.Role, min) {
		return nil, ErrForbidden
	}
	return m, nil
}

func roleRank(r domain.OrgRole) int {
	switch r {
	case domain.OrgRoleAdmin:
		return 3
	case domain.OrgRoleMember:
		return 2
	case domain.OrgRoleViewer:
		return 1
	}
	return 0
}

func roleAtLeast(have, min domain.OrgRole) bool { return roleRank(have) >= roleRank(min) }

func (s *OrganizationService) Create(callerID string, req domain.CreateOrganizationRequest) (*domain.OrganizationResponse, error) {
	slug := slugify(req.Slug)
	if slug == "" {
		slug = slugify(req.Name)
	}
	if slug == "" {
		slug = uuid.NewString()[:8]
	}

	org := &domain.Organization{Name: req.Name, Slug: slug}
	org.ID = uuid.NewString()

	if err := s.repo.CreateWithOwner(org, callerID); err != nil {
		return nil, err
	}
	return &domain.OrganizationResponse{ID: org.ID, Name: org.Name, Slug: org.Slug, Role: domain.OrgRoleAdmin}, nil
}

func (s *OrganizationService) List(callerID string) ([]domain.OrganizationResponse, error) {
	return s.repo.ListForUser(callerID)
}

func (s *OrganizationService) Update(callerID, orgID string, req domain.UpdateOrganizationRequest) (*domain.OrganizationResponse, error) {
	m, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin)
	if err != nil {
		return nil, err
	}
	org, err := s.repo.FindByID(orgID)
	if err != nil {
		return nil, err
	}
	org.Name = req.Name
	if err := s.repo.Update(org); err != nil {
		return nil, err
	}
	return &domain.OrganizationResponse{ID: org.ID, Name: org.Name, Slug: org.Slug, Role: m.Role}, nil
}

func (s *OrganizationService) Delete(callerID, orgID string) error {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin); err != nil {
		return err
	}
	return s.repo.Delete(orgID)
}

func (s *OrganizationService) ListMembers(callerID, orgID string) ([]domain.MemberResponse, error) {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleViewer); err != nil {
		return nil, err
	}
	return s.repo.ListMembers(orgID)
}

func (s *OrganizationService) AddMember(callerID, orgID string, req domain.AddMemberRequest) error {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin); err != nil {
		return err
	}
	return s.repo.UpsertMember(orgID, req.UserID, req.Role)
}

func (s *OrganizationService) UpdateMemberRole(callerID, orgID, targetID string, req domain.UpdateMemberRequest) error {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin); err != nil {
		return err
	}
	// Don't let the last admin demote themselves out of admin.
	if req.Role != domain.OrgRoleAdmin {
		if err := s.guardLastAdmin(orgID, targetID); err != nil {
			return err
		}
	}
	return s.repo.UpdateMemberRole(orgID, targetID, req.Role)
}

func (s *OrganizationService) RemoveMember(callerID, orgID, targetID string) error {
	// Admins can remove anyone; any member can remove themselves (leave).
	if callerID != targetID {
		if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin); err != nil {
			return err
		}
	}
	if err := s.guardLastAdmin(orgID, targetID); err != nil {
		return err
	}
	return s.repo.RemoveMember(orgID, targetID)
}

// guardLastAdmin returns ErrLastAdmin if targetID is the org's only admin.
func (s *OrganizationService) guardLastAdmin(orgID, targetID string) error {
	target, err := s.repo.GetMembership(orgID, targetID)
	if errors.Is(err, repository.ErrMembershipNotFound) {
		return nil // nothing to guard; downstream op reports not-found
	}
	if err != nil {
		return err
	}
	if target.Role != domain.OrgRoleAdmin {
		return nil
	}
	admins, err := s.repo.CountAdmins(orgID)
	if err != nil {
		return err
	}
	if admins <= 1 {
		return ErrLastAdmin
	}
	return nil
}
