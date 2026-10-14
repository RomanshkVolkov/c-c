package service

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ─── Los .md del repo, copiados por árbol (ver domain/repo_doc.go) ───────────

var (
	// ErrRepoDocsOff: el repo no está atado a un espacio, o tiene los docs
	// apagados. No hay copia que poner al día.
	ErrRepoDocsOff = errors.New("this repository does not show its docs")
	// ErrNotARepoImage: la ruta pedida no es una imagen dentro del repo.
	ErrNotARepoImage = errors.New("not an image of this repository")
)

// maxRepoBlobBytes: lo más que se baja de un fichero. Un markdown más grande
// no cabe en MaxDocBodyChars de todos modos; así no se baja para tirarlo.
const maxRepoBlobBytes = 4 * domain.MaxDocBodyChars

// maxRepoImageBytes: lo más que se sirve de una imagen del repo.
const maxRepoImageBytes = 10 << 20

type ghTree struct {
	Sha       string `json:"sha"`
	Truncated bool   `json:"truncated"`
	Tree      []struct {
		Path string `json:"path"`
		Type string `json:"type"`
		Sha  string `json:"sha"`
		Size int64  `json:"size"`
	} `json:"tree"`
}

// escapePath escapa cada segmento de una ruta del repo, sin tocar las barras.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// SyncRepoDocs pone al día la copia de los docs de un repo.
//
// Pide el árbol entero de la rama por defecto. Si es el mismo árbol de la
// última vez, termina ahí sin bajar nada: es lo que hace barato llamarla en
// cada push. Si no, baja sólo los blobs cuyo sha cambió y borra lo que ya no
// está, salvo con el árbol cortado.
func (s *GitHubService) SyncRepoDocs(repoID int64) error {
	if !s.CanRead() {
		return ErrGitHubOff
	}
	l := s.lockFor(fmt.Sprintf("repo-docs:%d", repoID))
	l.Lock()
	defer l.Unlock()

	repo, err := s.repo.FindRepo(repoID)
	if err != nil {
		return err
	}
	if repo.OrgID == "" || repo.SpaceID == "" || !repo.ShowDocs {
		return ErrRepoDocsOff
	}
	err = s.syncRepoDocs(repo)
	if err != nil {
		_ = s.repo.MarkRepoDocs(repoID, domain.RepoDocsError)
	}
	return err
}

func (s *GitHubService) syncRepoDocs(repo *domain.GitHubRepo) error {
	branch := repo.DocsBranch
	if branch == "" {
		var info struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := s.asInstallation(repo.InstallationID, http.MethodGet, "/repos/"+repo.FullName, nil, &info); err != nil {
			return err
		}
		if info.DefaultBranch == "" {
			return fmt.Errorf("github: %s has no default branch", repo.FullName)
		}
		branch = info.DefaultBranch
		if err := s.repo.SetDocsBranch(repo.RepoID, branch); err != nil {
			return err
		}
		repo.DocsTreeSha = ""
	}

	var tree ghTree
	if err := s.asInstallation(repo.InstallationID, http.MethodGet,
		"/repos/"+repo.FullName+"/git/trees/"+url.PathEscape(branch)+"?recursive=1", nil, &tree); err != nil {
		return err
	}
	if tree.Sha != "" && tree.Sha == repo.DocsTreeSha && repo.DocsState != domain.RepoDocsError {
		return nil
	}

	type blob struct {
		path, sha string
		size      int64
	}
	var files []blob
	for _, e := range tree.Tree {
		if e.Type == "blob" && domain.IsRepoDocPath(e.Path) {
			files = append(files, blob{e.Path, e.Sha, e.Size})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
	state := domain.RepoDocsOK
	if tree.Truncated || len(files) > domain.MaxRepoDocs {
		state = domain.RepoDocsTruncated
		if len(files) > domain.MaxRepoDocs {
			files = files[:domain.MaxRepoDocs]
		}
	}

	have, err := s.repo.RepoDocShas(repo.RepoID)
	if err != nil {
		return err
	}
	out := struct {
		upserts []domain.RepoDoc
		deletes []string
	}{}
	seen := make(map[string]bool, len(files))
	for _, f := range files {
		seen[f.path] = true
		if have[f.path] == f.sha {
			continue
		}
		doc := domain.RepoDoc{OrgID: repo.OrgID, RepoID: repo.RepoID, Path: f.path, BlobSha: f.sha}
		if f.size > maxRepoBlobBytes {
			doc.TooLarge = true
		} else {
			body, err := s.repoBlob(repo, f.sha)
			if err != nil {
				return err
			}
			if !utf8.ValidString(body) || utf8.RuneCountInString(body) > domain.MaxDocBodyChars {
				doc.TooLarge = true
			} else {
				doc.Body = body
			}
		}
		doc.Title = domain.RepoDocTitle(f.path, doc.Body)
		out.upserts = append(out.upserts, doc)
	}
	// Con el árbol cortado no se sabe si lo que falta se borró o no vino.
	if state == domain.RepoDocsOK {
		for p := range have {
			if !seen[p] {
				out.deletes = append(out.deletes, p)
			}
		}
	}
	return s.repo.ApplyRepoDocs(repo.RepoID, repository.RepoDocsSync{
		Upserts: out.upserts, Deletes: out.deletes, Branch: branch, TreeSha: tree.Sha, State: state, At: s.now().UTC(),
	})
}

// repoBlob: el contenido de un blob, que GitHub da en base64 con saltos de
// línea. Un sha es su contenido, así que esto no cambia nunca para un sha.
func (s *GitHubService) repoBlob(repo *domain.GitHubRepo, sha string) (string, error) {
	var b struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := s.asInstallation(repo.InstallationID, http.MethodGet,
		"/repos/"+repo.FullName+"/git/blobs/"+url.PathEscape(sha), nil, &b); err != nil {
		return "", err
	}
	if b.Encoding != "base64" {
		return b.Content, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(b.Content, "\n", ""))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// syncRepoDocsLater: lo mismo, en otra goroutine si el servicio es
// asíncrono. Un fallo no sube a nadie: queda en `docs_state` y en el log.
func (s *GitHubService) syncRepoDocsLater(repoID int64) {
	run := func() {
		if err := s.SyncRepoDocs(repoID); err != nil && !errors.Is(err, ErrRepoDocsOff) {
			lg.Warn(fmt.Sprintf("github: docs of repo %d did not sync: %v", repoID, err))
		}
	}
	if s.async {
		go run()
		return
	}
	run()
}

// docsOnPush: un push a la rama de los docs pone la copia al día. A otra
// rama, nada: los docs son los de la rama por defecto, no los de una PR.
func (s *GitHubService) docsOnPush(p *ghPayload) {
	repo := s.linkedRepo(p.Repository.ID)
	if repo == nil || !repo.ShowDocs || p.Deleted || !s.CanRead() {
		return
	}
	branch := branchOfRef(p.Ref)
	// La rama por defecto viene en cada push: si cambió en GitHub, se sigue.
	if def := p.Repository.DefaultBranch; def != "" && def != repo.DocsBranch {
		if err := s.repo.SetDocsBranch(repo.RepoID, def); err != nil {
			return
		}
		repo.DocsBranch = def
	}
	if branch == "" || branch != repo.DocsBranch {
		return
	}
	s.syncRepoDocsLater(repo.RepoID)
}

// SyncRepoDocsNow: el botón «Sincronizar» de la org. En el mismo hilo, para
// que la respuesta ya diga cómo salió.
func (s *GitHubService) SyncRepoDocsNow(orgID, id string) (*domain.GitHubRepo, error) {
	repo, err := s.repo.FindRepoInOrg(orgID, id)
	if err != nil {
		return nil, err
	}
	if err := s.SyncRepoDocs(repo.RepoID); err != nil {
		return nil, err
	}
	return s.repo.FindRepoInOrg(orgID, id)
}

// SpaceOrg: la org de un espacio, para saber quién puede ver sus docs.
func (s *GitHubService) SpaceOrg(spaceID string) (string, error) { return s.repo.SpaceOrg(spaceID) }

func (s *GitHubService) RepoDocsForSpace(orgID, spaceID string) ([]domain.RepoDocsGroup, error) {
	return s.repo.RepoDocsForSpace(orgID, spaceID)
}

// RepoDoc: un doc del repo, si el repo sigue enseñándolos.
func (s *GitHubService) RepoDoc(id string) (*domain.RepoDocResponse, error) {
	d, repo, err := s.repo.FindRepoDoc(id)
	if err != nil {
		return nil, err
	}
	if repo.OrgID != d.OrgID || repo.SpaceID == "" || !repo.ShowDocs {
		return nil, ErrRepoDocsOff
	}
	return &domain.RepoDocResponse{
		RepoDoc: *d, FullName: repo.FullName, Branch: repo.DocsBranch, SpaceID: repo.SpaceID,
		HTMLURL: domain.RepoBlobURL(repo.FullName, repo.DocsBranch, d.Path), SyncedAt: repo.DocsSyncedAt,
	}, nil
}

// RepoDocByPath: el doc de un repo de la org por su ruta, para lo que llega
// como URL de GitHub (`…/blob/<rama>/<ruta>`): un enlace o un include. Sólo
// repos de esa org: pegar la URL de un repo ajeno no lee nada.
func (s *GitHubService) RepoDocByPath(orgID, fullName, path string) (*domain.RepoDocResponse, error) {
	repo, err := s.repo.FindRepoByName(orgID, fullName)
	if err != nil {
		return nil, err
	}
	d, err := s.repo.FindRepoDocByPath(repo.RepoID, strings.TrimPrefix(path, "/"))
	if err != nil {
		return nil, err
	}
	return s.RepoDoc(d.ID)
}

// RepoForDocs: un repo que enseña sus docs, por su id de GitHub.
func (s *GitHubService) RepoForDocs(repoID int64) (*domain.GitHubRepo, error) {
	repo, err := s.repo.FindRepo(repoID)
	if err != nil {
		return nil, err
	}
	if repo.OrgID == "" || repo.SpaceID == "" || !repo.ShowDocs {
		return nil, ErrRepoDocsOff
	}
	return repo, nil
}

// RepoImage: los bytes de una imagen del repo, en su rama de docs, para un
// `<img>` de un doc del repo privado. La ruta pasa por RepoImagePath antes
// de llegar a GitHub: sólo imágenes, nunca un `..`.
func (s *GitHubService) RepoImage(repo *domain.GitHubRepo, raw string) ([]byte, string, error) {
	clean, ct, ok := domain.RepoImagePath(raw)
	if !ok {
		return nil, "", ErrNotARepoImage
	}
	if !s.CanRead() {
		return nil, "", ErrGitHubOff
	}
	tok, err := s.installationToken(repo.InstallationID)
	if err != nil {
		return nil, "", err
	}
	path := "/repos/" + repo.FullName + "/contents/" + escapePath(clean)
	if repo.DocsBranch != "" {
		path += "?ref=" + url.QueryEscape(repo.DocsBranch)
	}
	req, err := http.NewRequest(http.MethodGet, s.app.APIURL+path, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "token "+tok)
	req.Header.Set("Accept", "application/vnd.github.raw")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := s.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, "", fmt.Errorf("github GET %s: %d", path, res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxRepoImageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(b) > maxRepoImageBytes {
		return nil, "", ErrNotARepoImage
	}
	return b, ct, nil
}
