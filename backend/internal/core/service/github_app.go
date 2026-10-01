package service

import (
	"bytes"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ─── La App como cliente de GitHub (R6) ───────────────────────────────────────
//
// Para escribir en GitHub —el Deployment de cada deploy y su estado— la App se
// identifica con un JWT RS256 firmado con su llave privada, y con él pide un
// token por instalación, corto, que se guarda hasta poco antes de caducar.
//
// Nada de esto puede frenar ni hacer fallar un deploy: corre aparte, y si
// GitHub no contesta, el deploy ni se entera.

// GitHubAppKey: lo que hace falta para escribir. Sin ello, la App sigue
// comentando en las tareas (R5) y no escribe en GitHub.
type GitHubAppKey struct {
	AppID int64
	Key   *rsa.PrivateKey
	// APIURL: `https://api.github.com` salvo en las pruebas.
	APIURL string
}

func (s *GitHubService) CanWrite() bool {
	return s.Configured() && s.app.AppID > 0 && s.app.Key != nil && s.deployRepo != nil
}

// WithApp le da a la App con qué escribir.
func (s *GitHubService) WithApp(k GitHubAppKey) *GitHubService {
	if k.APIURL == "" {
		k.APIURL = "https://api.github.com"
	}
	s.app = k
	return s
}

// WithDeploys: los deploys, para que `workflow_run` cuente como el aviso del
// CI y para seguir cada deploy en GitHub.
func (s *GitHubService) WithDeploys(svc *DeployService, repo *repository.DeployRepository) *GitHubService {
	s.deploys, s.deployRepo = svc, repo
	return s
}

// Sync: lo que se cuenta a GitHub, en el mismo hilo. Sólo para las pruebas.
func (s *GitHubService) Sync() *GitHubService {
	s.async = false
	return s
}

// appJWT: el JWT de la App, de diez minutos como mucho (el tope de GitHub),
// con un minuto hacia atrás por si el reloj de GitHub va por delante.
func (s *GitHubService) appJWT() (string, error) {
	now := s.now()
	return jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.RegisteredClaims{
		Issuer:    strconv.FormatInt(s.app.AppID, 10),
		IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
		ExpiresAt: jwt.NewNumericDate(now.Add(9 * time.Minute)),
	}).SignedString(s.app.Key)
}

type installationToken struct {
	token string
	until time.Time
}

func (s *GitHubService) installationToken(id int64) (string, error) {
	s.mu.Lock()
	if t, ok := s.tokens[id]; ok && s.now().Before(t.until) {
		s.mu.Unlock()
		return t.token, nil
	}
	s.mu.Unlock()

	appJWT, err := s.appJWT()
	if err != nil {
		return "", err
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := s.call("Bearer "+appJWT, http.MethodPost, fmt.Sprintf("/app/installations/%d/access_tokens", id), nil, &out); err != nil {
		return "", err
	}
	s.mu.Lock()
	s.tokens[id] = installationToken{token: out.Token, until: out.ExpiresAt.Add(-time.Minute)}
	s.mu.Unlock()
	return out.Token, nil
}

func (s *GitHubService) call(auth, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, s.app.APIURL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("github %s %s: %d", method, path, res.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
}

func (s *GitHubService) asInstallation(id int64, method, path string, body, out any) error {
	tok, err := s.installationToken(id)
	if err != nil {
		return err
	}
	return s.call("token "+tok, method, path, body, out)
}

// ─── El Deployment de cada deploy ─────────────────────────────────────────────

// ghState: cómo se dice en GitHub cada estado de un deploy. `queued` no tiene:
// crear el Deployment ya lo deja pendiente.
var ghState = map[string]string{
	domain.DeployRunning:   "in_progress",
	domain.DeploySucceeded: "success",
	domain.DeployFailed:    "failure",
}

// DeploymentChanged: el observador de los deploys (ver DeployObserver).
func (s *GitHubService) DeploymentChanged(d *domain.Deployable, dep *domain.Deployment) {
	// Sin repo en el servicio no hay nada que contar: `syncDeployment` no lo
	// encuentra entre los de la org y se para ahí.
	if !s.CanWrite() {
		return
	}
	d2, dep2 := *d, *dep
	if s.async {
		go s.syncDeployment(&d2, &dep2)
		return
	}
	s.syncDeployment(&d2, &dep2)
}

// lockFor: un deploy a la vez por deployment. Los avisos van cada uno en su
// goroutine y pueden llegar desordenados; con esto, el que llegue primero
// crea el Deployment y el otro lo encuentra hecho.
func (s *GitHubService) lockFor(id string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.locks[id]
	if !ok {
		l = &sync.Mutex{}
		s.locks[id] = l
	}
	return l
}

func (s *GitHubService) syncDeployment(d *domain.Deployable, dep *domain.Deployment) {
	repo, err := s.repo.FindRepoByName(d.OrgID, d.RepoFullName)
	if err != nil {
		return
	}
	sha := shaOfImage(dep.Image)
	if !domain.ValidSha(sha) {
		return
	}
	l := s.lockFor(dep.ID)
	l.Lock()
	defer l.Unlock()

	cur, err := s.deployRepo.FindDeploymentByID(dep.ID)
	if err != nil {
		return
	}
	ghID := cur.GitHubDeploymentID
	if ghID == 0 {
		env := d.Environment
		if env == "" {
			env = "production"
		}
		var out struct {
			ID int64 `json:"id"`
		}
		if err := s.asInstallation(repo.InstallationID, http.MethodPost, "/repos/"+repo.FullName+"/deployments", map[string]any{
			"ref": sha, "environment": env, "auto_merge": false, "required_contexts": []string{},
			"description": ghTruncate("cac · "+d.Name, 140), "production_environment": env == "prod" || env == "production",
		}, &out); err != nil || out.ID == 0 {
			return
		}
		ghID = out.ID
		if err := s.deployRepo.SetGitHubDeploymentID(dep.ID, ghID); err != nil {
			return
		}
	}
	if state, ok := ghState[dep.Status]; ok {
		_ = s.asInstallation(repo.InstallationID, http.MethodPost,
			fmt.Sprintf("/repos/%s/deployments/%d/statuses", repo.FullName, ghID), map[string]any{
				"state": state, "description": ghTruncate(dep.Error, 140), "auto_inactive": true,
			}, nil)
	}
	if dep.Status == domain.DeploySucceeded {
		s.commentDeploy(repo, d, dep, sha)
	}
}

// maxCompareCommits: los commits entre lo de antes y lo nuevo que se leen
// para saber qué tareas acaban de llegar a producción.
const maxCompareCommits = 50

// commentDeploy deja en cada tarea que nombran los commits que este deploy
// trae —los de entre lo que había y lo nuevo— una línea de que ya está
// desplegada. Interna y una sola vez, como las de los commits.
func (s *GitHubService) commentDeploy(repo *domain.GitHubRepo, d *domain.Deployable, dep *domain.Deployment, sha string) {
	if repo.SpaceID == "" {
		return
	}
	var messages []string
	base := shaOfImage(dep.PreviousImage)
	if domain.ValidSha(base) && base != sha {
		var cmp struct {
			Commits []struct {
				Commit struct {
					Message string `json:"message"`
				} `json:"commit"`
			} `json:"commits"`
		}
		if err := s.asInstallation(repo.InstallationID, http.MethodGet,
			fmt.Sprintf("/repos/%s/compare/%s...%s", repo.FullName, base, sha), nil, &cmp); err != nil {
			return
		}
		for i, c := range cmp.Commits {
			if i >= maxCompareCommits {
				break
			}
			messages = append(messages, c.Commit.Message)
		}
	} else {
		var one struct {
			Commit struct {
				Message string `json:"message"`
			} `json:"commit"`
		}
		if err := s.asInstallation(repo.InstallationID, http.MethodGet,
			fmt.Sprintf("/repos/%s/commits/%s", repo.FullName, sha), nil, &one); err != nil {
			return
		}
		messages = append(messages, one.Commit.Message)
	}
	env := d.Environment
	if env == "" {
		env = "production"
	}
	line := fmt.Sprintf("deploy `%s` → %s · %s", sha[:7], env, d.Name)
	_ = s.comment(repo, strings.Join(messages, "\n"), "deploy:"+dep.ID, line)
}

// shaOfImage: el tag de una imagen (`repo:sha@sha256:…` → `sha`).
func shaOfImage(image string) string {
	ref, _, _ := strings.Cut(image, "@")
	i := strings.LastIndex(ref, ":")
	if i < 0 || i < strings.LastIndex(ref, "/") {
		return ""
	}
	return ref[i+1:]
}

func ghTruncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// ─── workflow_run: el workflow que publica la imagen ──────────────────────────

func (s *GitHubService) onWorkflowRun(p *ghPayload) error {
	run := p.WorkflowRun
	if p.Action != "completed" || run.Conclusion != "success" || s.deploys == nil {
		return nil
	}
	repo, err := s.repo.FindRepo(p.Repository.ID)
	if err != nil || repo.OrgID == "" {
		return nil
	}
	ds, err := s.deployRepo.DeployablesBuiltBy(repo.OrgID, repo.FullName)
	if err != nil {
		return err
	}
	for i := range ds {
		if run.Path != ".github/workflows/"+ds[i].BuildWorkflow {
			continue
		}
		_, err := s.deploys.Notice(&ds[i], domain.DeployNotice{
			Sha: run.HeadSha, Ref: "refs/heads/" + run.HeadBranch, Actor: run.Actor.Login, RunURL: safeURL(run.HTMLURL),
		}, "github")
		// Un sha que no vale o un servicio que no se puede desplegar ahora no
		// es motivo para que GitHub reintente la entrega: no va a cambiar.
		if err != nil && !errors.Is(err, ErrBadSha) {
			return err
		}
	}
	return nil
}
