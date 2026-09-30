package service

import (
	"errors"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrDeployNotSwarm      = errors.New("deploy-not-swarm")
	ErrBadImageRepo        = errors.New("bad-image-repo")
	ErrBadServiceName      = errors.New("bad-service-name")
	ErrBadSha              = errors.New("bad-sha")
	ErrNothingToRollBackTo = errors.New("nothing-to-roll-back-to")
	ErrRollbackOutsideRepo = errors.New("rollback-outside-repo")
	ErrAgentTooOld         = errors.New("agent-too-old")
)

// imageRepoPattern: un repositorio de imágenes sin tag ni digest
// (`ghcr.io/owner/repo`). El tag lo pone cada deploy.
var imageRepoPattern = regexp.MustCompile(`^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$`)

// dockerName: un nombre de stack o de servicio tal como los acepta Docker.
var dockerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

// DeployService: desplegar desde cac. Encola aquí; el agente del servidor lo
// recoge en su siguiente pregunta, despliega, y va contando por dónde va.
type DeployService struct {
	repo    *repository.DeployRepository
	servers *repository.ServerRepository
	hub     *events.Hub
	now     func() time.Time
}

func NewDeployService(repo *repository.DeployRepository, servers *repository.ServerRepository, hub *events.Hub) *DeployService {
	return &DeployService{repo: repo, servers: servers, hub: hub, now: time.Now}
}

func (s *DeployService) publish(orgID, kind string, data any) {
	if s.hub != nil {
		s.hub.Publish(events.Event{Type: kind, OrgID: orgID, Data: data})
	}
}

func (s *DeployService) CreateDeployable(server *domain.ServerResponse, req domain.CreateDeployableRequest) (*domain.Deployable, error) {
	if server.Type != domain.ServerTypeDockerSwarm {
		return nil, ErrDeployNotSwarm
	}
	if !imageRepoPattern.MatchString(req.ImageRepo) {
		return nil, ErrBadImageRepo
	}
	if !dockerName.MatchString(req.Stack) || !dockerName.MatchString(req.ServiceName) {
		return nil, ErrBadServiceName
	}
	d := &domain.Deployable{
		OrgID: server.OrgID, ServerID: server.ID, Name: req.Name,
		Stack: req.Stack, ServiceName: req.ServiceName, ImageRepo: req.ImageRepo,
		Environment: req.Environment, RepoFullName: req.RepoFullName,
		OnCINotify: "record",
	}
	d.ID = uuid.NewString()
	if err := s.repo.CreateDeployable(d); err != nil {
		return nil, err
	}
	return d, nil
}

func (s *DeployService) ListDeployables(serverID string) ([]domain.Deployable, error) {
	return s.repo.ListDeployables(serverID)
}

func (s *DeployService) FindDeployable(serverID, id string) (*domain.Deployable, error) {
	return s.repo.FindDeployable(serverID, id)
}

func (s *DeployService) UpdateDeployable(d *domain.Deployable, req domain.UpdateDeployableRequest) (*domain.Deployable, error) {
	d.Name, d.Environment, d.RepoFullName, d.OnCINotify = req.Name, req.Environment, req.RepoFullName, req.OnCINotify
	if err := s.repo.UpdateDeployable(d); err != nil {
		return nil, err
	}
	return d, nil
}

func (s *DeployService) DeleteDeployable(serverID, id string) error {
	return s.repo.DeleteDeployable(serverID, id)
}

// RequestDeploy encola el despliegue de un commit. La imagen se calcula aquí
// —`repo:sha`— y no se acepta de fuera: quien pide un deploy dice qué commit,
// no qué imagen.
//
// Con `idemKey` (el aviso del CI, R3), pedir dos veces lo mismo devuelve el
// deployment que ya existía y `created=false`.
func (s *DeployService) RequestDeploy(d *domain.Deployable, by, userID, sha, idemKey string) (dep *domain.Deployment, created bool, err error) {
	if !domain.ValidSha(sha) {
		return nil, false, ErrBadSha
	}
	return s.enqueue(d, by, userID, d.ImageRepo+":"+sha, "", idemKey)
}

// Rollback vuelve a lo que había antes de un deployment. Lo de antes lo leyó
// el agente del servicio al desplegar, así que puede ser algo que dejó el CI
// (`:latest`, por ejemplo); aun así tiene que ser del repositorio de este
// deployable y una referencia segura, o no se despliega.
func (s *DeployService) Rollback(d *domain.Deployable, deploymentID, userID string) (*domain.Deployment, error) {
	prev, err := s.repo.FindDeployment(d.ID, deploymentID)
	if err != nil {
		return nil, err
	}
	if prev.PreviousImage == "" {
		return nil, ErrNothingToRollBackTo
	}
	if _, ok := domain.ImageRef(d.ImageRepo, prev.PreviousImage); !ok {
		return nil, ErrRollbackOutsideRepo
	}
	dep, _, err := s.enqueue(d, domain.DeployByUser, userID, prev.PreviousImage, prev.ID, "")
	return dep, err
}

func (s *DeployService) enqueue(d *domain.Deployable, by, userID, image, rollbackOf, idemKey string) (*domain.Deployment, bool, error) {
	if idemKey != "" {
		if existing, err := s.repo.FindByIdempotency(d.ID, idemKey); err == nil {
			return existing, false, nil
		}
	}
	// Un agente que no sabe desplegar dejaría el deploy «en curso» hasta
	// caducar. Se dice al pedirlo, que es cuando alguien lo está mirando.
	srv, err := s.servers.FindByID(d.ServerID)
	if err != nil {
		return nil, false, err
	}
	if srv.AgentVersion < domain.AgentVersionDeploys {
		return nil, false, ErrAgentTooOld
	}
	now := s.now()
	if err := s.repo.ExpireStale(d.ID, now); err != nil {
		return nil, false, err
	}
	dep := &domain.Deployment{
		OrgID: d.OrgID, DeployableID: d.ID, ServerID: d.ServerID,
		Image: image, RequestedBy: by, RequestedByUserID: userID,
		Status: domain.DeployQueued, RollbackOfID: rollbackOf, IdempotencyKey: idemKey,
	}
	dep.ID = uuid.NewString()
	if err := s.repo.CreateDeployment(dep); err != nil {
		return nil, false, err
	}
	s.publish(d.OrgID, "deploy:status", dep)
	return dep, true, nil
}

// ─── El CI ────────────────────────────────────────────────────────────────────

// MintCIKey acuña la llave con la que el CI de este servicio avisa. La
// anterior deja de valer.
func (s *DeployService) MintCIKey(d *domain.Deployable) (*domain.CIKeyResponse, error) {
	plain, hash, err := repository.GenerateDeployKey()
	if err != nil {
		return nil, err
	}
	preview := plain[:len(repository.DeployKeyPrefix)+6] + "…"
	if err := s.repo.SetCIKey(d.ID, hash, preview); err != nil {
		return nil, err
	}
	return &domain.CIKeyResponse{Key: plain, Preview: preview}, nil
}

// DeployableByCIKey: el deployable de una llave del CI, o error.
func (s *DeployService) DeployableByCIKey(plain string) (*domain.Deployable, error) {
	return s.repo.FindDeployableByCIKey(repository.HashDeployKey(plain))
}

// Notice es el aviso del CI de que publicó la imagen de un commit.
//
// Siempre deja el build apuntado —es la lista de versiones que se pueden
// desplegar—, y en modo `deploy` además lo encola. Si no se puede encolar
// ahora (otro deploy en curso, un agente viejo), el aviso **no falla**: el
// build queda y la respuesta dice por qué no se desplegó. Un CI que falla
// porque dos commits llegaron seguidos enseña rojo por algo que no está roto.
func (s *DeployService) Notice(d *domain.Deployable, n domain.DeployNotice, source string) (*domain.DeployNoticeResponse, error) {
	if !domain.ValidSha(n.Sha) {
		return nil, ErrBadSha
	}
	b := &domain.ImageBuild{
		OrgID: d.OrgID, DeployableID: d.ID, Sha: n.Sha, Image: d.ImageRepo + ":" + n.Sha,
		Ref: n.Ref, Actor: n.Actor, RunURL: n.RunURL, Source: source,
	}
	b.ID = uuid.NewString()
	build, err := s.repo.RecordBuild(b)
	if err != nil {
		return nil, err
	}
	out := &domain.DeployNoticeResponse{Build: build, Deploy: "recorded"}
	if d.OnCINotify != "deploy" {
		return out, nil
	}
	by := domain.DeployByCI
	if source == "github" {
		by = domain.DeployByGitHub
	}
	dep, created, err := s.RequestDeploy(d, by, "", n.Sha, "ci:"+n.Sha)
	switch {
	case errors.Is(err, repository.ErrDeployInFlight):
		out.Deploy, out.Reason = "skipped", "deploy-in-flight"
	case errors.Is(err, ErrAgentTooOld):
		out.Deploy, out.Reason = "skipped", "agent-too-old"
	case err != nil:
		return nil, err
	case created:
		out.Deploy, out.Deployment = "queued", dep
	default:
		out.Deploy, out.Deployment = "exists", dep
	}
	return out, nil
}

func (s *DeployService) ListBuilds(deployableID string) ([]domain.ImageBuild, error) {
	return s.repo.ListBuilds(deployableID, 30)
}

func (s *DeployService) ListDeployments(deployableID string) ([]domain.DeploymentSummary, error) {
	return s.repo.ListDeployments(deployableID, 50)
}

func (s *DeployService) FindDeployment(deployableID, id string) (*domain.Deployment, error) {
	return s.repo.FindDeployment(deployableID, id)
}

// ─── Lo que pide el agente ────────────────────────────────────────────────────

// Claim le da al agente el siguiente deploy de su servidor, o nil.
func (s *DeployService) Claim(serverID string) (*domain.AgentJob, error) {
	dep, err := s.repo.ClaimNext(serverID, s.now())
	if err != nil || dep == nil {
		return nil, err
	}
	d, err := s.repo.FindDeployable(serverID, dep.DeployableID)
	if err != nil {
		return nil, err
	}
	s.publish(dep.OrgID, "deploy:status", dep)
	return &domain.AgentJob{
		ID:   dep.ID,
		Kind: "deploy",
		Data: domain.DeployJob{
			DeploymentID: dep.ID, Stack: d.Stack, ServiceName: d.ServiceName,
			ImageRepo: d.ImageRepo, Image: dep.Image,
		},
	}, nil
}

func (s *DeployService) AppendLog(serverID, id string, lines []string) error {
	orgID, deployableID, err := s.repo.AppendLog(serverID, id, lines)
	if err != nil {
		return err
	}
	s.publish(orgID, "deploy:log", map[string]any{
		"deploymentId": id, "deployableId": deployableID, "lines": lines,
	})
	return nil
}

func (s *DeployService) Finish(serverID, id string, req domain.AgentFinishRequest) error {
	dep, err := s.repo.Finish(serverID, id, req, s.now())
	if err != nil {
		return err
	}
	s.publish(dep.OrgID, "deploy:status", dep)
	return nil
}
