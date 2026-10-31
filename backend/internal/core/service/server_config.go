package service

import (
	"errors"
	"sort"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	// Basar un servidor en otro que no tiene config, o en sí mismo.
	ErrNothingToCopy = errors.New("nothing-to-copy")
	// Más referencias de las que tiene sentido guardar.
	ErrTooManyRefs = errors.New("too-many-op-refs")
)

const maxOpRefs = 100

// ServerConfigService: la config versionada de cada servidor y las plantillas
// de la org. Ver domain/server_config.go.
type ServerConfigService struct {
	repo    *repository.ServerConfigRepository
	servers *repository.ServerRepository
}

func NewServerConfigService(repo *repository.ServerConfigRepository, servers *repository.ServerRepository) *ServerConfigService {
	return &ServerConfigService{repo: repo, servers: servers}
}

// source: quién guardó, contado por cómo entró. Un token es un agente.
func source(user *domain.ClaimsJWT) string {
	if user != nil && user.ViaToken {
		return domain.ConfigSourceMCP
	}
	return domain.ConfigSourceApp
}

// ─── Config ───────────────────────────────────────────────────────────────────

func (s *ServerConfigService) Summary(serverID string) (*domain.ServerConfigSummary, error) {
	versions, err := s.repo.ConfigVersions(serverID)
	if err != nil {
		return nil, err
	}
	out := &domain.ServerConfigSummary{Versions: versions}
	if len(versions) > 0 {
		out.Current = &versions[0]
	}
	return out, nil
}

func (s *ServerConfigService) Version(serverID string, seq int) (*domain.ServerConfigVersion, error) {
	return s.repo.Config(serverID, seq)
}

// Save guarda una versión nueva de la config del servidor.
//
// Con `basedOnServerId` parte de la última de ese servidor —que tiene que ser
// de la misma org—: misma plantilla, mismas variables y mismas referencias
// menos las que la plantilla marca `perServer` (la contraseña de sudo de una
// máquina no es la de otra). Lo que venga en la petición va encima.
func (s *ServerConfigService) Save(server *domain.ServerResponse, user *domain.ClaimsJWT, req domain.PutServerConfigRequest) (*domain.ServerConfigVersion, error) {
	v := &domain.ServerConfigVersion{
		OrgID: server.OrgID, ServerID: server.ID,
		TemplateID: req.TemplateID, TemplateSeq: req.TemplateSeq,
		Vars: req.Vars, OpRefs: req.OpRefs,
		CreatedBy: user.UserID, Source: source(user), Note: strings.TrimSpace(req.Note),
	}
	if req.BasedOnServerID != "" {
		if err := s.copyFrom(server, req, v); err != nil {
			return nil, err
		}
	}
	if v.Vars == nil {
		v.Vars = map[string]any{}
	}
	if v.OpRefs == nil {
		v.OpRefs = map[string]string{}
	}
	for k, ref := range v.OpRefs {
		v.OpRefs[k] = strings.TrimSpace(ref)
	}
	var requires []string
	if v.TemplateID != "" {
		if _, err := s.repo.Template(server.OrgID, v.TemplateID); err != nil {
			return nil, err
		}
		tv, err := s.repo.TemplateVersion(v.TemplateID, v.TemplateSeq)
		if err != nil {
			return nil, err
		}
		v.TemplateSeq, requires = tv.Seq, tv.Requires
	} else {
		v.TemplateSeq = 0
	}
	if len(v.OpRefs) > maxOpRefs {
		return nil, ErrTooManyRefs
	}
	if err := domain.ValidateOpRefs(v.OpRefs); err != nil {
		return nil, err
	}
	if err := domain.ValidateConfigVars(v.Vars, requires); err != nil {
		return nil, err
	}
	if err := s.repo.SaveConfig(v); err != nil {
		return nil, err
	}
	return v, nil
}

func (s *ServerConfigService) copyFrom(server *domain.ServerResponse, req domain.PutServerConfigRequest, v *domain.ServerConfigVersion) error {
	if req.BasedOnServerID == server.ID {
		return ErrNothingToCopy
	}
	src, err := s.servers.FindByID(req.BasedOnServerID)
	// Un servidor de otra org se contesta igual que uno que no existe.
	if err != nil || src == nil || src.OrgID != server.OrgID {
		return ErrNothingToCopy
	}
	cur, err := s.repo.Config(src.ID, 0)
	if err != nil {
		return err
	}
	if cur == nil {
		return ErrNothingToCopy
	}
	perServer := map[string]bool{}
	if cur.TemplateID != "" {
		if tv, err := s.repo.TemplateVersion(cur.TemplateID, cur.TemplateSeq); err == nil {
			for _, p := range tv.PerServer {
				perServer[p] = true
			}
		}
	}
	vars := map[string]any{}
	for k, x := range cur.Vars {
		vars[k] = x
	}
	for k, x := range req.Vars {
		vars[k] = x
	}
	refs := map[string]string{}
	for k, x := range cur.OpRefs {
		if !perServer[k] {
			refs[k] = x
		}
	}
	for k, x := range req.OpRefs {
		refs[k] = x
	}
	v.Vars, v.OpRefs = vars, refs
	if v.TemplateID == "" {
		v.TemplateID, v.TemplateSeq = cur.TemplateID, cur.TemplateSeq
	}
	v.BasedOn = &domain.ConfigOrigin{ServerID: src.ID, Seq: cur.Seq}
	return nil
}

// Effective: lo que se aplicaría con la versión `seq` (0 = la actual). Un
// servidor sin config da una efectiva vacía, no un error: es lo que tiene.
func (s *ServerConfigService) Effective(server *domain.ServerResponse, seq int) (*domain.EffectiveConfig, error) {
	eff := &domain.EffectiveConfig{
		ServerID: server.ID, Playbooks: []string{}, Vars: map[string]any{}, OpRefs: map[string]string{},
		Requires: []string{}, PerServer: []string{}, Missing: []string{},
		Connection: domain.ServerConnection{Name: server.Name, Host: server.Host, SSHPort: server.SSHPort, SSHUser: server.SSHUser},
	}
	cfg, err := s.repo.Config(server.ID, seq)
	if err != nil || cfg == nil {
		return eff, err
	}
	eff.ConfigSeq = cfg.Seq
	tplVars := map[string]any{}
	if cfg.TemplateID != "" {
		t, err := s.repo.Template(server.OrgID, cfg.TemplateID)
		if err != nil {
			return nil, err
		}
		tv, err := s.repo.TemplateVersion(cfg.TemplateID, cfg.TemplateSeq)
		if err != nil {
			return nil, err
		}
		eff.TemplateID, eff.TemplateName, eff.TemplateSeq = t.ID, t.Name, tv.Seq
		eff.Playbooks, eff.Requires, eff.PerServer = nonNil(tv.Playbooks), nonNil(tv.Requires), nonNil(tv.PerServer)
		tplVars = tv.Vars
	}
	eff.Vars = domain.MergeVars(tplVars, cfg.Vars)
	for k, v := range cfg.OpRefs {
		eff.OpRefs[k] = v
	}
	for _, r := range eff.Requires {
		if _, ok := eff.OpRefs[r]; !ok {
			eff.Missing = append(eff.Missing, r)
		}
	}
	sort.Strings(eff.Missing)
	return eff, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ─── Plantillas ───────────────────────────────────────────────────────────────

func (s *ServerConfigService) Templates(orgID string) ([]domain.ServerTemplateResponse, error) {
	return s.repo.Templates(orgID)
}

// Template: la plantilla de la org con todas sus versiones.
func (s *ServerConfigService) Template(orgID, id string) (*domain.ServerTemplate, []domain.ServerTemplateVersionResponse, error) {
	t, err := s.repo.Template(orgID, id)
	if err != nil {
		return nil, nil, err
	}
	vs, err := s.repo.TemplateVersions(id)
	return t, vs, err
}

func (s *ServerConfigService) CreateTemplate(orgID string, user *domain.ClaimsJWT, req domain.CreateServerTemplateRequest) (*domain.ServerTemplateResponse, error) {
	if err := domain.ValidateTemplate(req.PutServerTemplateRequest); err != nil {
		return nil, err
	}
	t := &domain.ServerTemplate{OrgID: orgID, Name: strings.TrimSpace(req.Name), Description: req.Description, CreatedBy: user.UserID}
	v := templateVersion(user, req.PutServerTemplateRequest)
	if err := s.repo.CreateTemplate(t, v); err != nil {
		return nil, err
	}
	return &domain.ServerTemplateResponse{ServerTemplate: *t, Current: &domain.ServerTemplateVersionResponse{ServerTemplateVersion: *v}}, nil
}

func (s *ServerConfigService) SaveTemplate(orgID, id string, user *domain.ClaimsJWT, req domain.PutServerTemplateRequest) (*domain.ServerTemplateVersion, error) {
	if _, err := s.repo.Template(orgID, id); err != nil {
		return nil, err
	}
	if err := domain.ValidateTemplate(req); err != nil {
		return nil, err
	}
	v := templateVersion(user, req)
	v.TemplateID = id
	if err := s.repo.SaveTemplateVersion(v); err != nil {
		return nil, err
	}
	return v, nil
}

func templateVersion(user *domain.ClaimsJWT, req domain.PutServerTemplateRequest) *domain.ServerTemplateVersion {
	vars := req.Vars
	if vars == nil {
		vars = map[string]any{}
	}
	return &domain.ServerTemplateVersion{
		Playbooks: req.Playbooks, Vars: vars, Requires: nonNil(req.Requires), PerServer: nonNil(req.PerServer),
		CreatedBy: user.UserID, Source: source(user), Note: strings.TrimSpace(req.Note),
	}
}
