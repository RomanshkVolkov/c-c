package http

import (
	"crypto/rand"
	"crypto/rsa"
	"fmt"
	"io"
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
Una release publicada en GitHub: cac apunta qué commits lleva y lo marca en
las tareas y los incidentes, sin mover ni cerrar nada
(command-and-control-295).

Contra un GitHub falso que sabe dos cosas: las releases del repo y los commits
de entre dos tags.
*/

const (
	shaRel1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	shaRel2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	shaRel3 = "3333333ccccccccccccccccccccccccccccccccc"
)

type releaseGitHub struct {
	mu    sync.Mutex
	calls []string
	// releases: lo que contesta `GET /repos/dwit/api/releases`.
	releases string
	// compare: los commits de cada `base...head`.
	compare map[string][]string
}

func (g *releaseGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, r.Method+" "+r.URL.Path)
	io.ReadAll(r.Body)
	switch {
	case strings.HasSuffix(r.URL.Path, "/access_tokens"):
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"token":"ghs_prueba","expires_at":%q}`, time.Now().Add(time.Hour).Format(time.RFC3339))
	case r.URL.Path == "/repos/dwit/api/releases":
		io.WriteString(w, g.releases)
	case strings.HasPrefix(r.URL.Path, "/repos/dwit/api/compare/"):
		shas, ok := g.compare[strings.TrimPrefix(r.URL.Path, "/repos/dwit/api/compare/")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var parts []string
		for _, s := range shas {
			parts = append(parts, fmt.Sprintf(`{"sha":%q,"html_url":"https://github.com/dwit/api/commit/%s","commit":{"message":"commit %s\n\ncuerpo"}}`, s, s, s[:7]))
		}
		fmt.Fprintf(w, `{"total_commits":%d,"commits":[%s]}`, len(shas), strings.Join(parts, ","))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (g *releaseGitHub) asked(prefix string) int {
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

type releaseFixture struct {
	*ghFixture
	gh *releaseGitHub
}

// Sobre el fixture de la R5 (repo 100 = dwit/api, org-1, enlazado a sp-1, con
// la tarea it-1 = cac#12), un GitHub falso y las tablas de releases e
// incidentes.
func releaseSetup(t *testing.T) *releaseFixture {
	t.Helper()
	f, _ := githubSetup(t)
	if err := f.db.AutoMigrate(&domain.Release{}, &domain.ReleaseCommit{}, &domain.Doc{},
		&domain.Incident{}, &domain.IncidentCommit{}, &domain.IncidentServer{}, &domain.IncidentArea{},
		&domain.IncidentGuard{}, &domain.Server{}); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &releaseGitHub{releases: `[]`, compare: map[string][]string{}}
	api := httptest.NewServer(fake)
	t.Cleanup(api.Close)
	gh := service.NewGitHubService(repository.NewGitHubRepository(f.db),
		service.GitHubConfig{AppSlug: "cac-test", WebhookSecret: ghSecret}, events.NewHub()).
		WithApp(service.GitHubAppKey{AppID: appID, Key: key, APIURL: api.URL}).Sync()
	r := chi.NewRouter()
	InitGitHubRoutesWith(r, gh)
	f.r = r
	return &releaseFixture{ghFixture: f, gh: fake}
}

func releaseEvent(action, tag string, published time.Time, draft, prerelease bool) string {
	return fmt.Sprintf(`{"action":%q,"repository":{"id":100,"full_name":"dwit/api"},
		"release":{"tag_name":%q,"name":"C-C %s","html_url":"https://github.com/dwit/api/releases/tag/%s",
		"draft":%v,"prerelease":%v,"published_at":%q,"author":{"login":"jose"}}}`,
		action, tag, tag, tag, draft, prerelease, published.UTC().Format(time.RFC3339))
}

func (f *releaseFixture) releasedLines(itemID string) []string {
	var out []string
	for _, c := range f.comments(itemID) {
		if strings.HasPrefix(c.SourceKey, "gh:release:") {
			out = append(out, c.Body)
		}
	}
	return out
}

func (f *releaseFixture) count(table string) int64 {
	var n int64
	f.db.Table(table).Count(&n)
	return n
}

// Lo que pide jose: un commit que salió en una release lo dice, y la tarea
// que lo nombra recibe una línea, una sola vez aunque GitHub entregue el
// evento dos veces.
//
// Roturas que atrapa: no guardar los commits de la release, no cruzarlos al
// leer los enlaces de la tarea, comentar por cada entrega, o volver a
// preguntarle a GitHub en una reentrega.
func TestAPublishedReleaseMarksItsCommitsAndTellsTheirTasksOnce(t *testing.T) {
	f := releaseSetup(t)
	f.hook(t, "push", "d-p1", push(100, shaRel2, "fix: el login cac#12"))
	f.hook(t, "push", "d-p2", push(100, shaRel3, "chore: otra cosa cac#12"))
	day := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	f.db.Create(&domain.Release{OrgID: "org-1", RepoID: 100, RepoFullName: "dwit/api", Tag: "v1.0.0", PublishedAt: day})
	f.gh.compare["v1.0.0...v1.1.0"] = []string{shaRel2, shaRel1}

	body := releaseEvent("published", "v1.1.0", day.Add(24*time.Hour), false, false)
	f.hook(t, "release", "d-r1", body)
	f.hook(t, "release", "d-r2", body)

	git, err := repository.GitLinksOf(f.db, "it-1")
	if err != nil || git == nil {
		t.Fatalf("sin enlaces: %v", err)
	}
	byKey := map[string]*domain.ReleaseRef{}
	for _, c := range git.Commits {
		byKey[c.Key] = c.ReleasedIn
	}
	if r := byKey[shaRel2]; r == nil || r.Tag != "v1.1.0" {
		t.Errorf("el commit que salió no lo dice: %+v", r)
	}
	if r := byKey[shaRel3]; r != nil {
		t.Errorf("un commit que no salió dice que sí: %+v", r)
	}
	lines := f.releasedLines("it-1")
	if len(lines) != 1 || !strings.Contains(lines[0], "v1.1.0") || !strings.Contains(lines[0], "1 commit ") {
		t.Errorf("la tarea no recibió una línea, y una sola: %q", lines)
	}
	if n := f.gh.asked("GET /repos/dwit/api/compare/"); n != 1 {
		t.Errorf("una reentrega volvió a preguntar a GitHub (%d compare)", n)
	}
	if n := f.count("releases"); n != 2 {
		t.Errorf("%d releases, se esperaban 2", n)
	}
	if lines := f.releasedLines("it-2"); len(lines) != 0 {
		t.Errorf("se escribió en la tarea de otra org: %q", lines)
	}
}

// Roturas que atrapa: preguntar siempre a GitHub por la anterior (aunque cac
// la tenga), o no preguntarle cuando cac no la tiene (la primera release
// desde que cac escucha se quedaría sin commits), o tomar una prerelease
// como anterior.
func TestThePreviousTagComesFromOurTableBeforeGitHub(t *testing.T) {
	f := releaseSetup(t)
	day := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	f.gh.releases = fmt.Sprintf(`[
		{"tag_name":"v1.1.0","published_at":%q},
		{"tag_name":"v1.1.0-rc1","prerelease":true,"published_at":%q},
		{"tag_name":"v1.0.0","published_at":%q}]`,
		day.Add(24*time.Hour).Format(time.RFC3339), day.Add(12*time.Hour).Format(time.RFC3339), day.Format(time.RFC3339))
	f.gh.compare["v1.0.0...v1.1.0"] = []string{shaRel1}
	f.gh.compare["v1.1.0...v1.2.0"] = []string{shaRel2}

	f.hook(t, "release", "d-1", releaseEvent("published", "v1.1.0", day.Add(24*time.Hour), false, false))
	if n := f.gh.asked("GET /repos/dwit/api/releases"); n != 1 {
		t.Fatalf("sin la anterior en cac no se preguntó a GitHub (%d)", n)
	}
	var rel domain.Release
	f.db.Where("tag = ?", "v1.1.0").First(&rel)
	if rel.PrevTag != "v1.0.0" || rel.CommitCount != 1 {
		t.Errorf("la anterior no es la final de GitHub: prev=%q commits=%d", rel.PrevTag, rel.CommitCount)
	}

	f.hook(t, "release", "d-2", releaseEvent("published", "v1.2.0", day.Add(48*time.Hour), false, false))
	if n := f.gh.asked("GET /repos/dwit/api/releases"); n != 1 {
		t.Errorf("con la anterior en cac se volvió a preguntar a GitHub (%d)", n)
	}
	var next domain.Release
	f.db.Where("tag = ?", "v1.2.0").First(&next)
	if next.PrevTag != "v1.1.0" {
		t.Errorf("la anterior de v1.2.0 es %q", next.PrevTag)
	}
}

// Roturas que atrapa: quitar cualquiera de los filtros (borrador,
// prerelease, una acción que no es `published`).
func TestADraftAPrereleaseOrAnotherActionWritesNothing(t *testing.T) {
	f := releaseSetup(t)
	day := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	f.gh.compare["v1.0.0...v1.1.0"] = []string{shaRel1}
	f.db.Create(&domain.Release{OrgID: "org-1", RepoID: 100, RepoFullName: "dwit/api", Tag: "v1.0.0", PublishedAt: day})
	for i, body := range []string{
		releaseEvent("published", "v1.1.0", day.Add(time.Hour), true, false),
		releaseEvent("published", "v1.1.0", day.Add(time.Hour), false, true),
		releaseEvent("created", "v1.1.0", day.Add(time.Hour), false, false),
		releaseEvent("released", "v1.1.0", day.Add(time.Hour), false, false),
	} {
		f.hook(t, "release", fmt.Sprintf("d-%d", i), body)
	}
	if n := f.count("releases"); n != 1 {
		t.Errorf("se guardó una release que no cuenta (%d)", n)
	}
	if n := f.gh.asked("GET /repos/dwit/api/compare/"); n != 0 {
		t.Errorf("se preguntó a GitHub por una que no cuenta (%d)", n)
	}
}

// Roturas que atrapa: no borrar los commits de una release quitada (el
// commit seguiría diciendo que salió), o borrar la línea del hilo.
func TestDeletingAReleaseUnmarksItsCommitsAndKeepsTheLine(t *testing.T) {
	f := releaseSetup(t)
	f.hook(t, "push", "d-p1", push(100, shaRel1, "fix: el login cac#12"))
	day := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	f.db.Create(&domain.Release{OrgID: "org-1", RepoID: 100, RepoFullName: "dwit/api", Tag: "v1.0.0", PublishedAt: day})
	f.gh.compare["v1.0.0...v1.1.0"] = []string{shaRel1}
	f.hook(t, "release", "d-1", releaseEvent("published", "v1.1.0", day.Add(time.Hour), false, false))
	f.hook(t, "release", "d-2", releaseEvent("deleted", "v1.1.0", day.Add(time.Hour), false, false))

	git, _ := repository.GitLinksOf(f.db, "it-1")
	if git == nil || len(git.Commits) != 1 || git.Commits[0].ReleasedIn != nil {
		t.Errorf("el commit de una release borrada sigue diciendo que salió: %+v", git)
	}
	if n := f.count("release_commits"); n != 0 {
		t.Errorf("quedan %d commits de la release borrada", n)
	}
	if lines := f.releasedLines("it-1"); len(lines) != 1 {
		t.Errorf("la línea del hilo no se quedó: %q", lines)
	}
}

// Un incidente apunta sus commits con el sha corto y a veces sin repo
// (`domain.ParseCommitRef`). Sale cuando todos salieron.
//
// Roturas que atrapa: cruzar por igualdad (el corto no casa nunca), dar por
// salido uno con algún commit fuera, o marcar uno sin commits.
func TestAnIncidentKnowsWhenItsFixShipped(t *testing.T) {
	f := releaseSetup(t)
	day := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	rel := &domain.Release{OrgID: "org-1", RepoID: 100, RepoFullName: "dwit/api", Tag: "v1.1.0", PublishedAt: day}
	if _, err := repository.NewGitHubRepository(f.db).SaveRelease(rel,
		[]domain.ReleaseCommit{{SHA: shaRel1}, {SHA: shaRel2}}); err != nil {
		t.Fatal(err)
	}
	f.db.Create(&domain.Doc{BaseModel: domain.BaseModel{ID: "doc-1"}, OrgID: "org-1", OwnerKind: domain.DocOwnerSpace, OwnerID: "sp-1"})
	mk := func(id string, shas ...[2]string) {
		f.db.Create(&domain.Incident{BaseModel: domain.BaseModel{ID: id}, OrgID: "org-1", DocID: "doc-1", Title: id, Status: domain.IncidentOpen})
		for i, s := range shas {
			f.db.Create(&domain.IncidentCommit{ID: fmt.Sprintf("%s-%d", id, i), IncidentID: id, SHA: s[0], Repo: s[1]})
		}
	}
	mk("inc-corto", [2]string{shaRel1[:7], ""})
	mk("inc-dos", [2]string{shaRel1, "dwit/api"}, [2]string{shaRel2[:9], "dwit/api"})
	mk("inc-falta", [2]string{shaRel1[:7], ""}, [2]string{shaRel3[:7], ""})
	mk("inc-otro-repo", [2]string{shaRel1[:7], "dwit/web"})
	mk("inc-sin")

	list, err := repository.NewIncidentRepository(f.db).List(domain.IncidentFilter{OrgIDs: []string{"org-1"}})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, i := range list {
		if i.Shipped != nil {
			got[i.ID] = i.Shipped.Tag
		}
	}
	want := map[string]string{"inc-corto": "v1.1.0", "inc-dos": "v1.1.0"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("salidos %v, se esperaban %v", got, want)
	}
}
