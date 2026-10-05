package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrGitHubOff       = errors.New("github app not configured")
	ErrBadLinkState    = errors.New("bad or expired github link state")
	ErrSpaceOutsideOrg = errors.New("space is not in this org")
)

// GitHubConfig: lo que el servidor sabe de la App. Sin las dos, todo lo de
// GitHub contesta 503 (la postura de `RECORDINGS_ENABLED`).
//
// No hace falta la llave privada de la App para esto: instalar, recibir sus
// webhooks y comentar en las tareas sólo pide el slug (para la URL de
// instalación) y el secreto del webhook (para verificar lo que llega). La
// llave hará falta para escribir en GitHub.
type GitHubConfig struct {
	AppSlug       string
	WebhookSecret string
}

func (c GitHubConfig) Configured() bool { return c.AppSlug != "" && c.WebhookSecret != "" }

// linkStateTTL: lo que dura el enlace de instalar desde que se pide.
const linkStateTTL = 10 * time.Minute

// maxCommitsPerPush: los commits de un push que se leen. Un push de una rama
// vieja puede traer cientos, y ninguno vale cien comentarios.
const maxCommitsPerPush = 20

type GitHubService struct {
	repo *repository.GitHubRepository
	cfg  GitHubConfig
	hub  *events.Hub
	now  func() time.Time

	// Para escribir en GitHub (R6). Ver github_app.go.
	app        GitHubAppKey
	deploys    *DeployService
	deployRepo *repository.DeployRepository
	// Los runs del CI de los repos de la org (R9). nil = no se apuntan.
	runs *repository.ActivityRepository
	// La campana y a quién llamar (R9). nil = no suena.
	inbox  Notifier
	orgs   *repository.OrganizationRepository
	http   *http.Client
	async  bool
	mu     sync.Mutex
	tokens map[int64]installationToken
	locks  map[string]*sync.Mutex
}

func NewGitHubService(repo *repository.GitHubRepository, cfg GitHubConfig, hub *events.Hub) *GitHubService {
	return NewGitHubServiceAt(repo, cfg, time.Now).withHub(hub)
}

// NewGitHubServiceAt: con otro reloj, para probar que un state caduca.
func NewGitHubServiceAt(repo *repository.GitHubRepository, cfg GitHubConfig, now func() time.Time) *GitHubService {
	return &GitHubService{
		repo: repo, cfg: cfg, now: now,
		http: &http.Client{Timeout: 10 * time.Second}, async: true,
		tokens: map[int64]installationToken{}, locks: map[string]*sync.Mutex{},
	}
}

func (s *GitHubService) withHub(hub *events.Hub) *GitHubService {
	s.hub = hub
	return s
}

func (s *GitHubService) Configured() bool { return s.cfg.Configured() }

func (s *GitHubService) Status(orgID string) (*domain.GitHubStatusResponse, error) {
	out := &domain.GitHubStatusResponse{Configured: s.Configured(),
		Installations: []domain.GitHubInstallation{}, Repos: []domain.GitHubRepo{}}
	if !out.Configured {
		return out, nil
	}
	insts, repos, err := s.repo.ListForOrg(orgID)
	if err != nil {
		return nil, err
	}
	out.Installations, out.Repos = insts, repos
	return out, nil
}

// ─── Atar una instalación a una org ───────────────────────────────────────────
//
// GitHub manda al navegador de quien instaló a la URL de setup con el
// `installation_id` y el `state` que le dimos. El state va firmado y lleva la
// org: sin él, cualquiera podría atar una instalación a la org que quisiera.
// Y una instalación sólo se ata una vez (ErrInstallationTaken).

func (s *GitHubService) LinkURL(orgID string) (string, error) {
	if !s.Configured() {
		return "", ErrGitHubOff
	}
	return "https://github.com/apps/" + url.PathEscape(s.cfg.AppSlug) + "/installations/new?state=" +
		url.QueryEscape(s.signState(orgID, s.now().Add(linkStateTTL))), nil
}

func (s *GitHubService) stateMAC(orgID string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.WebhookSecret))
	fmt.Fprintf(mac, "github-link:%s:%d", orgID, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *GitHubService) signState(orgID string, exp time.Time) string {
	e := exp.Unix()
	return base64.RawURLEncoding.EncodeToString([]byte(orgID)) + "." + strconv.FormatInt(e, 10) + "." + s.stateMAC(orgID, e)
}

func (s *GitHubService) verifyState(state string) (string, error) {
	parts := strings.Split(state, ".")
	if len(parts) != 3 {
		return "", ErrBadLinkState
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	exp, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || err2 != nil || len(raw) == 0 {
		return "", ErrBadLinkState
	}
	orgID := string(raw)
	if !hmac.Equal([]byte(parts[2]), []byte(s.stateMAC(orgID, exp))) || s.now().Unix() > exp {
		return "", ErrBadLinkState
	}
	return orgID, nil
}

func (s *GitHubService) Setup(installationID int64, state string) error {
	if !s.Configured() {
		return ErrGitHubOff
	}
	orgID, err := s.verifyState(state)
	if err != nil {
		return err
	}
	if installationID <= 0 {
		return ErrBadLinkState
	}
	return s.repo.BindInstallation(installationID, orgID)
}

// LinkRepo enlaza un repo de la org a un espacio de la misma org ("" = soltarlo).
func (s *GitHubService) LinkRepo(orgID, id string, req domain.UpdateGitHubRepoRequest) (*domain.GitHubRepo, error) {
	repo, err := s.repo.FindRepoInOrg(orgID, id)
	if err != nil {
		return nil, err
	}
	if req.SpaceID != "" && !s.repo.SpaceInOrg(req.SpaceID, orgID) {
		return nil, ErrSpaceOutsideOrg
	}
	if err := s.repo.LinkRepo(repo.ID, req.SpaceID, req.BareRefs); err != nil {
		return nil, err
	}
	repo.SpaceID, repo.BareRefs = req.SpaceID, req.BareRefs
	return repo, nil
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

// VerifySignature: `X-Hub-Signature-256` sobre los bytes **crudos** del cuerpo.
// Verificar sobre un JSON re-serializado daría por mala una firma buena (y al
// revés no hay forma segura de hacerlo).
func (s *GitHubService) VerifySignature(body []byte, header string) bool {
	if !s.Configured() || !strings.HasPrefix(header, "sha256=") {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.WebhookSecret))
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(header), []byte(want))
}

type ghRepoRef struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
}

type ghPayload struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	} `json:"installation"`
	Repositories        []ghRepoRef `json:"repositories"`
	RepositoriesAdded   []ghRepoRef `json:"repositories_added"`
	RepositoriesRemoved []ghRepoRef `json:"repositories_removed"`
	Repository          ghRepoRef   `json:"repository"`
	Commits             []struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		URL     string `json:"url"`
		Author  struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		} `json:"author"`
	} `json:"commits"`
	WorkflowRun struct {
		ID           int64      `json:"id"`
		RunNumber    int        `json:"run_number"`
		RunAttempt   int        `json:"run_attempt"`
		Name         string     `json:"name"`
		Status       string     `json:"status"`
		Conclusion   string     `json:"conclusion"`
		Event        string     `json:"event"`
		Path         string     `json:"path"`
		HeadSha      string     `json:"head_sha"`
		HeadBranch   string     `json:"head_branch"`
		HTMLURL      string     `json:"html_url"`
		CreatedAt    time.Time  `json:"created_at"`
		UpdatedAt    time.Time  `json:"updated_at"`
		RunStartedAt *time.Time `json:"run_started_at"`
		Actor        struct {
			Login string `json:"login"`
		} `json:"actor"`
		// TriggeringActor: en un re-run, quien lo relanzó; `actor` sigue siendo
		// el del push original.
		TriggeringActor struct {
			Login string `json:"login"`
		} `json:"triggering_actor"`
		HeadCommit struct {
			Message string `json:"message"`
		} `json:"head_commit"`
	} `json:"workflow_run"`
	Number      int `json:"number"`
	PullRequest struct {
		Title   string `json:"title"`
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
		Merged  bool   `json:"merged"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"pull_request"`
}

// Handle procesa una entrega ya verificada.
//
// Una reentrega de GitHub (o la misma entrega dos veces) no duplica nada, y
// no hace falta apuntar las entregas para eso: guardar instalaciones y repos
// es idempotente, y cada línea en una tarea lleva su `SourceKey`, que la base
// no deja escribir dos veces.
func (s *GitHubService) Handle(event string, body []byte) error {
	return s.handle(event, body)
}

func (s *GitHubService) handle(event string, body []byte) error {
	var p ghPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return err
	}
	switch event {
	case "installation":
		if p.Action == "deleted" {
			return s.repo.DeleteInstallation(p.Installation.ID)
		}
		if err := s.repo.UpsertInstallation(p.Installation.ID, p.Installation.Account.Login); err != nil {
			return err
		}
		for _, r := range p.Repositories {
			if err := s.repo.UpsertRepo(p.Installation.ID, r.ID, r.FullName); err != nil {
				return err
			}
		}
	case "installation_repositories":
		for _, r := range p.RepositoriesAdded {
			if err := s.repo.UpsertRepo(p.Installation.ID, r.ID, r.FullName); err != nil {
				return err
			}
		}
		for _, r := range p.RepositoriesRemoved {
			if err := s.repo.DeleteRepo(r.ID); err != nil {
				return err
			}
		}
	case "push":
		return s.onPush(&p)
	case "pull_request":
		return s.onPullRequest(&p)
	case "workflow_run":
		return s.onWorkflowRun(&p)
	}
	return nil
}

func (s *GitHubService) linkedRepo(id int64) *domain.GitHubRepo {
	repo, err := s.repo.FindRepo(id)
	if err != nil || repo.OrgID == "" || repo.SpaceID == "" {
		return nil
	}
	return repo
}

// orgRepo: el repo si es de alguna org, enlazado a un espacio o no. Es la
// puerta de lo que no comenta en tareas (los runs del CI): un repo que la
// instalación deja ver pero que nadie ha atado no es de nadie, y lo suyo se
// ignora en silencio.
func (s *GitHubService) orgRepo(id int64) *domain.GitHubRepo {
	repo, err := s.repo.FindRepo(id)
	if err != nil || repo.OrgID == "" {
		return nil
	}
	return repo
}

func (s *GitHubService) onPush(p *ghPayload) error {
	repo := s.linkedRepo(p.Repository.ID)
	if repo == nil {
		return nil
	}
	commits := p.Commits
	if len(commits) > maxCommitsPerPush {
		commits = commits[:maxCommitsPerPush]
	}
	for _, c := range commits {
		if !domain.ValidSha(c.ID) {
			continue
		}
		who := c.Author.Username
		if who != "" {
			who = "@" + who
		} else {
			who = c.Author.Name
		}
		line := fmt.Sprintf("`%s` [%s](%s) · %s · %s", c.ID[:7], mdText(firstLine(c.Message)), safeURL(c.URL), who, repo.FullName)
		if err := s.comment(repo, c.Message, "gh:push:"+c.ID, line); err != nil {
			return err
		}
	}
	return nil
}

// prActions: lo que de una PR se cuenta en la tarea. Lo demás (labels,
// revisiones, ediciones) es ruido en un hilo.
var prActions = map[string]bool{"opened": true, "closed": true, "reopened": true}

func (s *GitHubService) onPullRequest(p *ghPayload) error {
	if !prActions[p.Action] {
		return nil
	}
	repo := s.linkedRepo(p.Repository.ID)
	if repo == nil {
		return nil
	}
	action := p.Action
	if action == "closed" && p.PullRequest.Merged {
		action = "merged"
	}
	line := fmt.Sprintf("PR #%d %s: [%s](%s) · @%s · %s", p.Number, action,
		mdText(p.PullRequest.Title), safeURL(p.PullRequest.HTMLURL), p.PullRequest.User.Login, repo.FullName)
	return s.comment(repo, p.PullRequest.Title+"\n"+p.PullRequest.Body,
		fmt.Sprintf("gh:pr:%d:%d:%s", repo.RepoID, p.Number, action), line)
}

// comment deja la línea en cada tarea que nombre el texto, una sola vez por
// tarea y procedencia. Lo que no resuelve se descarta sin más; y sólo se busca
// dentro de la org del repo (`FindRefTarget`).
func (s *GitHubService) comment(repo *domain.GitHubRepo, text, source, line string) error {
	for _, ref := range domain.ExtractTaskRefs(text, repo.BareRefs) {
		item, err := s.repo.FindRefTarget(repo.OrgID, repo.SpaceID, ref)
		if err != nil {
			continue
		}
		created, err := s.repo.AddSourcedComment(newSourcedComment(item.ID, source, line))
		if err != nil {
			return err
		}
		if created && s.hub != nil {
			s.hub.Publish(events.Event{Type: "task:comment", OrgID: item.OrgID,
				Data: map[string]string{"listId": item.ListID, "taskId": item.ID}})
		}
	}
	return nil
}

// newSourcedComment: una línea de sistema, **interna**. Lo que pasa en el
// código del equipo no es asunto del cliente aunque la tarea la vea él: sus
// mensajes de commit no van a su hilo. Por eso no es `newSystemComment`, que
// es pública a propósito.
func newSourcedComment(itemID, source, body string) *domain.ItemComment {
	c := &domain.ItemComment{
		ItemID:     itemID,
		Kind:       domain.CommentKindSystem,
		Visibility: domain.VisibilityInternal,
		Body:       body,
		SourceKey:  source,
	}
	c.ID = uuid.NewString()
	return c
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	if r := []rune(line); len(r) > 120 {
		line = string(r[:120]) + "…"
	}
	return line
}

// mdText: lo que va dentro de `[…]` en markdown, sin cerrar el enlace antes.
func mdText(s string) string {
	return strings.NewReplacer("[", "(", "]", ")", "\n", " ").Replace(s)
}

// safeURL: sólo enlaces a GitHub. Lo que llega va firmado por GitHub, pero un
// `javascript:` en un comentario no se pinta nunca.
func safeURL(u string) string {
	if strings.HasPrefix(u, "https://github.com/") {
		return strings.NewReplacer("(", "%28", ")", "%29", " ", "%20").Replace(u)
	}
	return "https://github.com/"
}
