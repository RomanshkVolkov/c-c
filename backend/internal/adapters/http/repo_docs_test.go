package http

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Los .md del repo, copiados en Documentación (docs as code). Contra un GitHub
falso que sabe dar la rama por defecto, un árbol, sus blobs y el contenido
crudo de cualquier ruta —también de las que no debería servir nadie—, y que
apunta lo que le piden.
*/

type docsGitHub struct {
	mu        sync.Mutex
	calls     []string
	treeSha   string
	truncated bool
	files     map[string]string // ruta → contenido; el sha sale del contenido
}

func blobSha(body string) string { return "sha-" + base64.RawURLEncoding.EncodeToString([]byte(body)) }

func (g *docsGitHub) set(files map[string]string, treeSha string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.files, g.treeSha = files, treeSha
}

func (g *docsGitHub) asked(prefix string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, c := range g.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (g *docsGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, r.Method+" "+r.URL.Path)
	p := r.URL.Path
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(p, "/access_tokens"):
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "t", "expires_at": time.Now().Add(time.Hour)})
	case p == "/repos/dwit/web":
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	case p == "/repos/dwit/web/git/trees/main":
		tree := []map[string]any{{"path": "docs", "type": "tree", "sha": "d"}}
		for path, body := range g.files {
			tree = append(tree, map[string]any{"path": path, "type": "blob", "sha": blobSha(body), "size": len(body)})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sha": g.treeSha, "truncated": g.truncated, "tree": tree})
	case strings.HasPrefix(p, "/repos/dwit/web/git/blobs/"):
		sha := strings.TrimPrefix(p, "/repos/dwit/web/git/blobs/")
		for _, body := range g.files {
			if blobSha(body) == sha {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(body)) + "\n"})
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	case strings.HasPrefix(p, "/repos/dwit/web/contents/"):
		_, _ = w.Write([]byte("BYTES:" + strings.TrimPrefix(p, "/repos/dwit/web/contents/")))
	case strings.HasPrefix(p, "/repos/dwit/web/pulls"):
		_, _ = w.Write([]byte("[]"))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

var (
	admin1  = domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleAdmin}
	member1 = domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	member2 = domain.OrgMembershipClaim{OrgID: "org-2", Role: domain.OrgRoleMember}
)

func docsSetup(t *testing.T) (*ghFixture, *docsGitHub, string) {
	t.Helper()
	f, cleanup := githubSetup(t)
	t.Cleanup(cleanup)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &docsGitHub{}
	fake.set(map[string]string{
		"README.md":                   "# Web\n\nLa portada.",
		"docs/deploy.md":              "```sh\n# no es el título\n```\n# Desplegar\n",
		".github/ISSUE_TEMPLATE/x.md": "# plantilla",
		"node_modules/x/README.md":    "# dependencia",
		"main.go":                     "package main",
	}, "tree-1")
	api := httptest.NewServer(fake)
	t.Cleanup(api.Close)
	gh := service.NewGitHubService(repository.NewGitHubRepository(f.db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, events.NewHub()).
		WithApp(service.GitHubAppKey{AppID: appID, Key: key, APIURL: api.URL}).Sync()
	r := chi.NewRouter()
	InitGitHubRoutesWith(r, gh)
	f.r = r
	var repoID string
	f.db.Model(&domain.GitHubRepo{}).Where("repo_id = 200").Pluck("id", &repoID)
	return f, fake, repoID
}

func (f *ghFixture) docs(t *testing.T) map[string]domain.RepoDoc {
	t.Helper()
	var rows []domain.RepoDoc
	f.db.Where("repo_id = 200").Find(&rows)
	out := map[string]domain.RepoDoc{}
	for _, d := range rows {
		out[d.Path] = d
	}
	return out
}

func (f *ghFixture) linkWeb(t *testing.T, repoID, body string) {
	t.Helper()
	if rec := f.as(t, http.MethodPatch, "/api/v1/organizations/org-1/github/repos/"+repoID, body, admin1); rec.Code != http.StatusOK {
		t.Fatalf("vincular → %d %s", rec.Code, rec.Body.String())
	}
}

func (f *ghFixture) pushWeb(t *testing.T, ref string) {
	t.Helper()
	f.hook(t, "push", "d-push-"+ref+time.Now().String(), `{"ref":"`+ref+`","installation":{"id":5},
		"repository":{"id":200,"full_name":"dwit/web","default_branch":"main"},"commits":[]}`)
}

// Atar el repo a un espacio copia sus .md —los suyos, no los de sus
// plantillas ni sus dependencias—, con el título de cada uno, y el panel los
// lista para los de la org.
func TestLinkingARepoCopiesItsDocs(t *testing.T) {
	f, _, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)

	docs := f.docs(t)
	if len(docs) != 2 || docs["README.md"].Title != "Web" || docs["docs/deploy.md"].Title != "Desplegar" {
		t.Fatalf("copia: %+v", docs)
	}
	if !strings.Contains(docs["README.md"].Body, "La portada.") {
		t.Fatalf("cuerpo: %q", docs["README.md"].Body)
	}

	rec := f.as(t, http.MethodGet, "/api/v1/repo-docs?spaceId=sp-1", "", member1)
	var out domain.APIResponse[[]domain.RepoDocsGroup]
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	// dwit/api ya estaba atado al mismo espacio y nunca se copió: sale, vacío,
	// para que el panel diga que falta sincronizarlo.
	var web *domain.RepoDocsGroup
	for i := range out.Data {
		if out.Data[i].FullName == "dwit/web" {
			web = &out.Data[i]
		}
	}
	if rec.Code != http.StatusOK || len(out.Data) != 2 || web == nil ||
		web.Branch != "main" || web.State != domain.RepoDocsOK || len(web.Files) != 2 {
		t.Fatalf("listado → %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "La portada.") {
		t.Fatal("el listado lleva los cuerpos")
	}
}

// Un push a la rama por defecto pone la copia al día: baja **sólo** lo que
// cambió o es nuevo, y borra lo que ya no está.
// Mutantes: comparar por ruta y no por sha (el README se queda viejo); bajar
// todo (un blob de más); no borrar.
func TestAPushUpdatesOnlyWhatChanged(t *testing.T) {
	f, fake, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	antes := fake.asked("GET /repos/dwit/web/git/blobs/")

	fake.set(map[string]string{
		"README.md":      "# Web 2\n\nOtra portada.",
		"docs/deploy.md": "```sh\n# no es el título\n```\n# Desplegar\n",
		"guía/paso.md":   "# Paso",
	}, "tree-2")
	f.pushWeb(t, "refs/heads/main")

	docs := f.docs(t)
	if docs["README.md"].Title != "Web 2" || docs["guía/paso.md"].Title != "Paso" {
		t.Fatalf("copia: %+v", docs)
	}
	if n := fake.asked("GET /repos/dwit/web/git/blobs/") - antes; n != 2 {
		t.Fatalf("blobs bajados: %d; deploy.md no cambió", n)
	}

	fake.set(map[string]string{"README.md": "# Web 2\n\nOtra portada."}, "tree-3")
	f.pushWeb(t, "refs/heads/main")
	if docs := f.docs(t); len(docs) != 1 {
		t.Fatalf("lo borrado del repo sigue en la copia: %+v", docs)
	}
}

// Un push a otra rama no toca los docs: son los de la rama por defecto, no
// los de una PR. Mutante: no mirar la rama.
func TestAPushToAnotherBranchDoesNotSync(t *testing.T) {
	f, fake, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	antes := fake.asked("GET /repos/dwit/web/git/trees/")
	fake.set(map[string]string{"README.md": "# Otro"}, "tree-x")
	f.pushWeb(t, "refs/heads/feature")
	if fake.asked("GET /repos/dwit/web/git/trees/") != antes || f.docs(t)["README.md"].Title != "Web" {
		t.Fatal("un push a otra rama cambió los docs")
	}
}

// Con el árbol cortado no se sabe si lo que falta se borró o no vino: se
// marca y no se borra nada. Mutante: borrar lo que falta igual.
func TestATruncatedTreeDeletesNothing(t *testing.T) {
	f, fake, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	fake.set(map[string]string{"README.md": "# Web\n\nLa portada."}, "tree-3")
	fake.truncated = true
	f.pushWeb(t, "refs/heads/main")

	if _, ok := f.docs(t)["docs/deploy.md"]; !ok {
		t.Fatal("un árbol cortado borró un doc")
	}
	var repo domain.GitHubRepo
	f.db.First(&repo, "repo_id = 200")
	if repo.DocsState != domain.RepoDocsTruncated {
		t.Fatalf("estado: %q", repo.DocsState)
	}
}

// Apagar los docs los borra; cambiar sólo el espacio desde una app que no
// sabe de `showDocs` no los apaga. Mutante: leer el campo como `bool`.
func TestShowDocsIsKeptUnlessSaid(t *testing.T) {
	f, _, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1","bareRefs":true}`)
	if len(f.docs(t)) != 2 {
		t.Fatal("un PATCH sin showDocs apagó los docs")
	}
	f.linkWeb(t, repoID, `{"spaceId":"sp-1","showDocs":false}`)
	if len(f.docs(t)) != 0 {
		t.Fatal("apagados, siguen copiados")
	}
	if rec := f.as(t, http.MethodGet, "/api/v1/repo-docs?spaceId=sp-1", "", member1); strings.Contains(rec.Body.String(), "dwit/web") {
		t.Fatalf("apagado, el panel lo sigue listando: %s", rec.Body.String())
	}
}

// Un doc del repo es de su org: a otra, 404, como si no existiera.
// Mutante: no comprobar la org en el handler.
func TestRepoDocsStayInTheirOrg(t *testing.T) {
	f, _, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	id := f.docs(t)["README.md"].ID

	if rec := f.as(t, http.MethodGet, "/api/v1/repo-docs/"+id, "", member1); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), `"htmlUrl":"https://github.com/dwit/web/blob/main/README.md"`) {
		t.Fatalf("de la org → %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.as(t, http.MethodGet, "/api/v1/repo-docs/"+id, "", member2); rec.Code != http.StatusNotFound {
		t.Fatalf("de otra org → %d", rec.Code)
	}
	if rec := f.as(t, http.MethodGet, "/api/v1/repo-docs?spaceId=sp-1", "", member2); rec.Code != http.StatusNotFound {
		t.Fatalf("el listado, a otra org → %d", rec.Code)
	}
}

// La ruta de las imágenes no sirve para leer otra cosa del repo con el token
// de la App, ni para que otra org vea las de este. Mutante: no pasar la ruta
// por RepoImagePath (el GitHub falso daría el `.env`).
func TestRepoDocRawOnlyServesImages(t *testing.T) {
	f, _, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	get := func(path string, org domain.OrgMembershipClaim) *httptest.ResponseRecorder {
		return f.as(t, http.MethodGet, "/api/v1/repo-docs/raw/200?path="+path, "", org)
	}
	if rec := get("docs/img/arq.png", member1); rec.Code != http.StatusOK ||
		rec.Body.String() != "BYTES:docs/img/arq.png" || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("imagen → %d %q %q", rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}
	for _, p := range []string{".env", "../x.png", "docs/../../a.png", "config/key.pem"} {
		if rec := get(p, member1); rec.Code != http.StatusNotFound {
			t.Errorf("%s → %d %q", p, rec.Code, rec.Body.String())
		}
	}
	if rec := get("docs/img/arq.png", member2); rec.Code != http.StatusNotFound {
		t.Fatalf("otra org → %d", rec.Code)
	}
}

// Una URL de GitHub pegada en un doc encuentra su fichero, sólo en la org que
// tiene el repo. Mutante: no comprobar la org (otra lo leería).
func TestARepoDocIsFoundByItsGitHubPath(t *testing.T) {
	f, _, repoID := docsSetup(t)
	f.linkWeb(t, repoID, `{"spaceId":"sp-1"}`)
	q := "/api/v1/repo-docs/lookup?repo=DWIT/web&path=docs/deploy.md&orgId="
	rec := f.as(t, http.MethodGet, q+"org-1", "", member1)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"title":"Desplegar"`) {
		t.Fatalf("de la org → %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.as(t, http.MethodGet, q+"org-1", "", member2); rec.Code != http.StatusNotFound {
		t.Fatalf("pidiendo la org ajena → %d", rec.Code)
	}
	if rec := f.as(t, http.MethodGet, "/api/v1/repo-docs/lookup?repo=dwit/web&path=nada.md&orgId=org-1", "", member1); rec.Code != http.StatusNotFound {
		t.Fatalf("un fichero que no está → %d", rec.Code)
	}
}
