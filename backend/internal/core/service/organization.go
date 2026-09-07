package service

import (
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrForbidden = errors.New("forbidden")
	ErrLastAdmin = errors.New("cannot remove the last admin of an organization")
)

type OrganizationService struct {
	repo *repository.OrganizationRepository
	// hub avisa a **la persona**, no a la organización.
	//
	// Puede ser nil: hay un sitio que construye este servicio sólo para
	// comprobar permisos y no tiene hub que darle. Sin él todo sigue
	// funcionando; lo que se pierde es el aviso, que es exactamente lo que
	// pasaba antes.
	hub *events.Hub
}

func NewOrganizationService(repo *repository.OrganizationRepository) *OrganizationService {
	return &OrganizationService{repo: repo}
}

// WithHub le da voz al servicio. Aparte del constructor para no obligar a los
// dos sitios que sólo lo usan para comprobar permisos a inventarse un hub.
func (s *OrganizationService) WithHub(h *events.Hub) *OrganizationService {
	s.hub = h
	return s
}

// avisarDeMembresia le cuenta a alguien que ha entrado o salido.
//
// **Dirigido a la persona y no a la organización**, que es la única forma de que
// funcione: el hub reparte por organización, y quien acaba de entrar todavía no
// la está escuchando — ése era justo el problema. Al salir pasa lo contrario y
// es peor: seguiría viendo una organización a la que ya no pertenece, y cada
// llamada daría error sin explicar por qué.
//
// El nombre viaja dentro porque quien lo recibe **no puede consultarlo**: al
// entrar todavía no tiene permiso para leer esa organización, y al salir ya no
// lo tiene. Un aviso que dice «te han añadido a algo» no es un aviso.
func (s *OrganizationService) avisarDeMembresia(orgID, userID string, dentro bool) {
	if s.hub == nil || orgID == "" || userID == "" {
		return
	}
	nombre := ""
	if o, err := s.repo.FindByID(orgID); err == nil && o != nil {
		nombre = o.Name
	}
	s.hub.Publish(events.Event{
		Type:   "org:membership",
		UserID: userID,
		Data: map[string]any{
			"orgId":   orgID,
			"orgName": nombre,
			"joined":  dentro,
		},
	})
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	out := slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	return strings.Trim(out, "-")
}

// requireRole loads the caller's membership and enforces a minimum role.
// Returns ErrForbidden when the caller lacks membership or sufficient role.
// A superadmin bypasses the check entirely (synthetic admin membership).
func (s *OrganizationService) requireRole(orgID, userID string, min domain.OrgRole, superadmin bool) (*domain.OrgMembership, error) {
	if superadmin {
		return &domain.OrgMembership{OrgID: orgID, UserID: userID, Role: domain.OrgRoleAdmin}, nil
	}
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

	org := &domain.Organization{
		Name: req.Name, Slug: slug,
		// Written here rather than left to a column default: GORM omits Go zero
		// values from an INSERT, so a `default:true` would make these
		// impossible to turn off.
		DefaultInviteRole:        domain.OrgRoleMember,
		ClientsSeeOnlyTheirSpace: true,
		GuestsCanUseDevTools:     true,
	}
	org.ID = uuid.NewString()

	if err := s.repo.CreateWithOwner(org, callerID); err != nil {
		return nil, err
	}
	return &domain.OrganizationResponse{
		ID: org.ID, Name: org.Name, Slug: org.Slug, Role: domain.OrgRoleAdmin,
		MemberCount: s.repo.MemberCount(org.ID), CreatedAt: org.CreatedAt,
		Domain: org.Domain, DefaultInviteRole: org.DefaultInviteRole,
		ClientsSeeOnlyTheirSpace: org.ClientsSeeOnlyTheirSpace,
		GuestsCanUseDevTools:     org.GuestsCanUseDevTools,
	}, nil
}

func (s *OrganizationService) List(callerID string, superadmin bool) ([]domain.OrganizationResponse, error) {
	if superadmin {
		return s.repo.ListAll()
	}
	return s.repo.ListForUser(callerID)
}

func (s *OrganizationService) Update(callerID, orgID string, req domain.UpdateOrganizationRequest, superadmin bool) (*domain.OrganizationResponse, error) {
	m, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin, superadmin)
	if err != nil {
		return nil, err
	}
	org, err := s.repo.FindByID(orgID)
	if err != nil {
		return nil, err
	}
	org.Name = req.Name
	// Only what was actually sent. A nil field is "the form did not mention
	// this", which is different from "set it to false" — and treating them the
	// same would let saving the name quietly turn two rules off.
	if req.Domain != nil {
		org.Domain = *req.Domain
	}
	if req.DefaultInviteRole != nil {
		org.DefaultInviteRole = *req.DefaultInviteRole
	}
	if req.ClientsSeeOnlyTheirSpace != nil {
		org.ClientsSeeOnlyTheirSpace = *req.ClientsSeeOnlyTheirSpace
	}
	if req.GuestsCanUseDevTools != nil {
		org.GuestsCanUseDevTools = *req.GuestsCanUseDevTools
	}
	if err := s.repo.Update(org); err != nil {
		return nil, err
	}
	return &domain.OrganizationResponse{
		ID: org.ID, Name: org.Name, Slug: org.Slug, Role: m.Role,
		MemberCount: s.repo.MemberCount(org.ID), CreatedAt: org.CreatedAt,
		Domain: org.Domain, DefaultInviteRole: org.DefaultInviteRole,
		ClientsSeeOnlyTheirSpace: org.ClientsSeeOnlyTheirSpace,
		GuestsCanUseDevTools:     org.GuestsCanUseDevTools,
	}, nil
}

// ErrOnlySuperadminDeletes: deleting an organization takes its spaces, its
// tasks and its channels with it, and stops every integration pointing at it.
//
// An org admin manages the place; ending it is a different kind of decision,
// and one nobody should be able to make for a client by themselves. The
// confirmation the app asks for is a second lock, not this one.
var ErrOnlySuperadminDeletes = errors.New("only a platform superadmin can delete an organization")

func (s *OrganizationService) Delete(callerID, orgID string, superadmin bool) error {
	if !superadmin {
		return ErrOnlySuperadminDeletes
	}
	return s.repo.Delete(orgID)
}

func (s *OrganizationService) ListMembers(callerID, orgID string, superadmin bool) ([]domain.MemberResponse, error) {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleViewer, superadmin); err != nil {
		return nil, err
	}
	return s.repo.ListMembers(orgID)
}

func (s *OrganizationService) AddMember(callerID, orgID string, req domain.AddMemberRequest, superadmin bool) error {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin, superadmin); err != nil {
		return err
	}
	if err := s.repo.UpsertMember(orgID, req.UserID, req.Role); err != nil {
		return err
	}
	s.avisarDeMembresia(orgID, req.UserID, true)
	return nil
}

func (s *OrganizationService) UpdateMemberRole(callerID, orgID, targetID string, req domain.UpdateMemberRequest, superadmin bool) error {
	if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin, superadmin); err != nil {
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

func (s *OrganizationService) RemoveMember(callerID, orgID, targetID string, superadmin bool) error {
	// Admins can remove anyone; any member can remove themselves (leave).
	if callerID != targetID {
		if _, err := s.requireRole(orgID, callerID, domain.OrgRoleAdmin, superadmin); err != nil {
			return err
		}
	}
	if err := s.guardLastAdmin(orgID, targetID); err != nil {
		return err
	}
	if err := s.repo.RemoveMember(orgID, targetID); err != nil {
		return err
	}
	s.avisarDeMembresia(orgID, targetID, false)
	return nil
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
