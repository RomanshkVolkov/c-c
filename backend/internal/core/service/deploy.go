package service

import (
	"errors"
	"regexp"
	"strings"
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
	ErrBadRepoName         = errors.New("bad-repo-name")
	ErrBadWorkflow         = errors.New("bad-workflow")
	ErrBadMigrateCommand   = errors.New("bad-migrate-command")
	ErrAgentCannotMigrate  = errors.New("agent-cannot-migrate")
	ErrBadSha              = errors.New("bad-sha")
	ErrNothingToRollBackTo = errors.New("nothing-to-roll-back-to")
	ErrRollbackOutsideRepo = errors.New("rollback-outside-repo")
	ErrAgentTooOld         = errors.New("agent-too-old")
	// ErrAgentCannotBuild: el servicio construye en el servidor y su agente es
	// anterior a la v6 (ver domain.AgentVersionBuilds).
	ErrAgentCannotBuild = errors.New("agent-cannot-build")
	// ErrBuildNeedsFullSha: construir es de un commit entero; con uno corto, el
	// contexto remoto de git no sabe cuál es.
	ErrBuildNeedsFullSha = errors.New("build-needs-full-sha")
	// ErrBuildNeedsRepo: un servicio que construye tiene que decir de qué repo.
	ErrBuildNeedsRepo = errors.New("build-needs-repo")
	ErrBadBranch      = errors.New("bad-branch")
	ErrBadBuildPath   = errors.New("bad-build-path")
)

// imageRepoPattern: un repositorio de imágenes sin tag ni digest
// (`ghcr.io/owner/repo`). El tag lo pone cada deploy.
var imageRepoPattern = regexp.MustCompile(`^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$`)

// repoFullName: `owner/name` como los escribe GitHub.
var repoFullName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$`)

// workflowFile: el nombre de fichero de un workflow, sin ruta.
var workflowFile = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}\.ya?ml$`)

// dockerName: un nombre de stack o de servicio tal como los acepta Docker.
var dockerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

// DeployService: desplegar desde cac. Encola aquí; el agente del servidor lo
// recoge en su siguiente pregunta, despliega, y va contando por dónde va.
type DeployService struct {
	repo     *repository.DeployRepository
	servers  *repository.ServerRepository
	hub      *events.Hub
	now      func() time.Time
	observer DeployObserver
	// La campana para los deploys que acaban, y la org para saber a quién
	// (R9). nil = no suena.
	inbox Notifier
	orgs  *repository.OrganizationRepository
	// Con qué clonar para construir en el servidor. nil = no se construye.
	tokens RepoTokens
}

// WithNotifier: que cada deploy que acaba —bien, mal o caducado— deje fila en
// la campana de la org.
func (s *DeployService) WithNotifier(inbox Notifier, orgs *repository.OrganizationRepository) *DeployService {
	s.inbox, s.orgs = inbox, orgs
	return s
}

// DeployObserver: quien quiere enterarse de cómo va cada deploy además de la
// app (hoy, GitHub, para su Deployment). Nunca puede frenar ni hacer fallar un
// deploy: lo que haga, lo hace por su cuenta.
type DeployObserver interface {
	DeploymentChanged(d *domain.Deployable, dep *domain.Deployment)
}

func (s *DeployService) WithObserver(o DeployObserver) *DeployService {
	s.observer = o
	return s
}

// changed: el evento para la app y el aviso al observador, siempre juntos. Y
// la campana, sólo cuando el deploy **acabó**: encolarse y arrancar se ven en
// vivo, pero lo que uno quiere saber después es cómo terminó.
func (s *DeployService) changed(d *domain.Deployable, dep *domain.Deployment) {
	s.publish(dep.OrgID, "deploy:status", dep)
	if s.observer != nil && d != nil {
		s.observer.DeploymentChanged(d, dep)
	}
	if d != nil && (dep.Status == domain.DeploySucceeded || dep.Status == domain.DeployFailed) {
		s.notifyDone(d, dep)
	}
}

// notifyDone deja en la campana de toda la org cómo acabó un deploy (R9),
// menos a quien lo pidió, que ya lo estaba mirando (y que la app te cuente lo
// que acabas de hacer es el fallo que este repo ya quitó tres veces). Un deploy
// del CI no lo pidió nadie de cac, así que llega a todos.
//
// Plegado por servicio (DeployableGroup): tres deploys seguidos de la api son
// una fila. El título va por clave; el cuerpo es el entorno y el tag.
func (s *DeployService) notifyDone(d *domain.Deployable, dep *domain.Deployment) {
	if s.inbox == nil || s.orgs == nil {
		return
	}
	members, err := s.orgs.MemberIDs(d.OrgID)
	if err != nil {
		return
	}
	ref, _ := domain.ImageRef(d.ImageRepo, dep.Image)
	if ref == "" {
		ref = dep.Image
	}
	phrase := domain.DeployPhrase(dep, d.Name, ref)
	body := d.Environment
	if body == "" {
		body = d.Name
	}
	body += " · `" + ref + "`"
	link := "/activity?deployable=" + d.ID + "&deployment=" + dep.ID
	seen := make(map[string]bool, len(members))
	for _, uid := range members {
		if uid == "" || uid == dep.RequestedByUserID || seen[uid] {
			continue
		}
		seen[uid] = true
		s.inbox.Notify(domain.Aviso{
			UserID: uid, OrgID: d.OrgID, Kind: "deploy:done",
			TitleKey: phrase.Clave, TitleArgs: phrase.Args,
			Body: body, Link: link, Via: domain.ViaApp,
			Group: domain.DeployableGroup(d.ID), Label: d.Name,
		})
	}
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
		OnCINotify: "record", ShortTags: req.ShortTags,
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
	if req.RepoFullName != "" && !repoFullName.MatchString(req.RepoFullName) {
		return nil, ErrBadRepoName
	}
	if req.BuildWorkflow != nil && *req.BuildWorkflow != "" && !workflowFile.MatchString(*req.BuildWorkflow) {
		return nil, ErrBadWorkflow
	}
	d.Name, d.Environment, d.RepoFullName, d.OnCINotify = req.Name, req.Environment, req.RepoFullName, req.OnCINotify
	if req.BuildWorkflow != nil {
		d.BuildWorkflow = *req.BuildWorkflow
	}
	if req.ShortTags != nil {
		d.ShortTags = *req.ShortTags
	}
	if req.Branch != nil {
		if !domain.ValidBranch(*req.Branch) {
			return nil, ErrBadBranch
		}
		d.Branch = *req.Branch
	}
	if req.Dockerfile != nil {
		if !domain.ValidBuildPath(*req.Dockerfile) {
			return nil, ErrBadBuildPath
		}
		d.Dockerfile = *req.Dockerfile
	}
	if req.BuildContext != nil {
		// `.` o `./` es la raíz, como en `docker build .`: se guarda vacía.
		ctx := strings.Trim(strings.TrimSpace(*req.BuildContext), "/")
		if ctx == "." {
			ctx = ""
		}
		if !domain.ValidBuildPath(ctx) {
			return nil, ErrBadBuildPath
		}
		d.BuildContext = ctx
	}
	if req.BuildOnHost != nil {
		d.BuildOnHost = *req.BuildOnHost
	}
	// Construir pide saber qué repo: sin él no hay de dónde clonar.
	if d.BuildOnHost && d.RepoFullName == "" {
		return nil, ErrBuildNeedsRepo
	}
	if req.MigrateCommand != nil {
		cmd := strings.TrimSpace(*req.MigrateCommand)
		// Una línea: es lo que va detrás de `sh -c`, y un salto de línea ahí
		// esconde un segundo comando que nadie ve en la pantalla.
		if strings.ContainsAny(cmd, "\n\r\x00") {
			return nil, ErrBadMigrateCommand
		}
		d.MigrateCommand = cmd
	}
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
	return s.requestDeployFor(d, by, userID, sha, idemKey, "")
}

// requestDeployFor: RequestDeploy sabiendo de qué run de GitHub viene. El id
// del run va **en la fila desde que nace** y no en un UPDATE después: el primer
// `deploy:status` que ve la app ya lleva el enlace, y nadie puede pillar un
// deploy sin su run entre las dos escrituras.
func (s *DeployService) requestDeployFor(d *domain.Deployable, by, userID, sha, idemKey, runID string) (*domain.Deployment, bool, error) {
	if !domain.ValidSha(sha) {
		return nil, false, ErrBadSha
	}
	// Un servicio que construye en el servidor construye cada commit que se
	// le pide desplegar: no hay CI que haya dejado la imagen.
	buildSha := ""
	if d.BuildOnHost {
		if len(sha) != 40 {
			return nil, false, ErrBuildNeedsFullSha
		}
		if d.RepoFullName == "" {
			return nil, false, ErrBuildNeedsRepo
		}
		buildSha = sha
	}
	return s.enqueue(d, by, userID, d.ImageRepo+":"+d.Tag(sha), "", idemKey, runID, buildSha)
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
	// Sin build: lo de antes ya está en el servidor.
	dep, _, err := s.enqueue(d, domain.DeployByUser, userID, prev.PreviousImage, prev.ID, "", "", "")
	return dep, err
}

func (s *DeployService) enqueue(d *domain.Deployable, by, userID, image, rollbackOf, idemKey, runID, buildSha string) (*domain.Deployment, bool, error) {
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
	if d.MigrateCommand != "" && srv.AgentVersion < domain.AgentVersionMigrates {
		return nil, false, ErrAgentCannotMigrate
	}
	if buildSha != "" && srv.AgentVersion < domain.AgentVersionBuilds {
		return nil, false, ErrAgentCannotBuild
	}
	now := s.now()
	expired, err := s.repo.ExpireStale(d.ID, now)
	if err != nil {
		return nil, false, err
	}
	// Los que caducan también se cuentan: en GitHub se quedarían «en curso»
	// para siempre.
	for i := range expired {
		s.changed(d, &expired[i])
	}
	dep := &domain.Deployment{
		OrgID: d.OrgID, DeployableID: d.ID, ServerID: d.ServerID,
		Image: image, RequestedBy: by, RequestedByUserID: userID,
		Status: domain.DeployQueued, RollbackOfID: rollbackOf, IdempotencyKey: idemKey,
		WorkflowRunID: runID, BuildSha: buildSha,
	}
	dep.ID = uuid.NewString()
	if err := s.repo.CreateDeployment(dep); err != nil {
		return nil, false, err
	}
	s.changed(d, dep)
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
	// De otra rama, no es para este servicio: ni se apunta ni se despliega.
	// Es lo que deja a prod y a test compartir repo, workflow y aviso.
	if !d.BuildsOn(branchOfRef(n.Ref)) {
		return &domain.DeployNoticeResponse{Deploy: "skipped", Reason: "other-branch"}, nil
	}
	// El build es del tag que existe: con tags cortos, el sha corto. Así el
	// mismo commit avisado entero (GitHub) o corto (el curl) es un solo build.
	// El entero se guarda: construir en el servidor lo necesita.
	fullSha := n.Sha
	n.Sha = d.Tag(n.Sha)
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
	if source == "github" || source == domain.BuildSourceHost {
		by = domain.DeployByGitHub
	}
	dep, created, err := s.requestDeployFor(d, by, "", fullSha, "ci:"+n.Sha, n.WorkflowRunID)
	switch {
	case errors.Is(err, repository.ErrDeployInFlight):
		out.Deploy, out.Reason = "skipped", "deploy-in-flight"
	case errors.Is(err, ErrAgentTooOld):
		out.Deploy, out.Reason = "skipped", "agent-too-old"
	case errors.Is(err, ErrAgentCannotMigrate):
		out.Deploy, out.Reason = "skipped", "agent-cannot-migrate"
	case errors.Is(err, ErrAgentCannotBuild):
		out.Deploy, out.Reason = "skipped", "agent-cannot-build"
	case errors.Is(err, ErrBuildNeedsFullSha):
		out.Deploy, out.Reason = "skipped", "build-needs-full-sha"
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
	s.changed(d, dep)
	job := domain.DeployJob{
		DeploymentID: dep.ID, Stack: d.Stack, ServiceName: d.ServiceName,
		ImageRepo: d.ImageRepo, Image: dep.Image, MigrateCommand: d.MigrateCommand,
	}
	if dep.BuildSha != "" {
		build, err := s.buildSpec(d, dep)
		if err != nil {
			// Sin con qué clonar no hay build: se da por fallido aquí, con el
			// motivo, en vez de mandarle al agente un trabajo que no puede hacer.
			done, ferr := s.repo.Finish(serverID, dep.ID, domain.AgentFinishRequest{
				Status: domain.DeployFailed, Error: err.Error(),
			}, s.now())
			if ferr == nil {
				s.changed(d, done)
			}
			return nil, nil
		}
		job.Build = build
	}
	return &domain.AgentJob{ID: dep.ID, Kind: "deploy", Data: job}, nil
}

// RepoTokens da con qué clonar un repo de la org: el token de la instalación
// de la GitHub App. Lo pone GitHubService (ver CloneToken).
type RepoTokens interface {
	CloneToken(orgID, repoFullName string) (string, error)
}

// WithRepoTokens: sin esto, ningún servicio puede construir en el servidor.
func (s *DeployService) WithRepoTokens(t RepoTokens) *DeployService {
	s.tokens = t
	return s
}

// ErrNoCloneToken: la GitHub App no ve el repo, o no está configurada.
var ErrNoCloneToken = errors.New("build-no-clone-token")

func (s *DeployService) buildSpec(d *domain.Deployable, dep *domain.Deployment) (*domain.BuildSpec, error) {
	if s.tokens == nil {
		return nil, ErrNoCloneToken
	}
	tok, err := s.tokens.CloneToken(d.OrgID, d.RepoFullName)
	if err != nil || tok == "" {
		return nil, ErrNoCloneToken
	}
	args, err := s.repo.BuildArgNames(d.ID)
	if err != nil {
		return nil, err
	}
	dockerfile := d.Dockerfile
	if dockerfile == "" {
		dockerfile = "Dockerfile"
	}
	return &domain.BuildSpec{
		Repo: d.RepoFullName, Sha: dep.BuildSha, Dockerfile: dockerfile, Context: d.BuildContext,
		BuildArgs: args, CloneToken: tok,
	}, nil
}

// PushBuild: un push a la rama de un servicio que construye en el servidor.
// En modo `deploy` encola construir y desplegar ese commit; en `record`, lo
// apunta como versión disponible, como el aviso de un CI.
func (s *DeployService) PushBuild(d *domain.Deployable, sha, ref, actor string) (*domain.DeployNoticeResponse, error) {
	if !d.BuildOnHost {
		return &domain.DeployNoticeResponse{Deploy: "skipped", Reason: "no-host-build"}, nil
	}
	return s.Notice(d, domain.DeployNotice{Sha: sha, Ref: ref, Actor: actor}, domain.BuildSourceHost)
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
	// Ya acabado: si el servicio se borró entretanto, la app se entera igual
	// y a GitHub no hay a quién contárselo.
	d, _ := s.repo.FindDeployable(serverID, dep.DeployableID)
	s.changed(d, dep)
	return nil
}

// DockerfilePath: dónde está el Dockerfile de un servicio dentro del repo
// (la carpeta del build más el Dockerfile, que es relativo a ella).
func DockerfilePath(d *domain.Deployable) string {
	f := d.Dockerfile
	if f == "" {
		f = "Dockerfile"
	}
	if d.BuildContext == "" {
		return f
	}
	return strings.Trim(d.BuildContext, "/") + "/" + f
}
