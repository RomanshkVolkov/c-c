package http

import (
	"fmt"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

func (f *ghFixture) links(itemID, kind string) []domain.TaskGitLink {
	var out []domain.TaskGitLink
	f.db.Where("item_id = ? AND kind = ?", itemID, kind).Order("occurred_at").Find(&out)
	return out
}

func pushOn(branch, sha, msg string) string {
	return fmt.Sprintf(`{"ref":"refs/heads/%s","repository":{"id":100,"full_name":"dwit/api"},
		"commits":[{"id":%q,"message":%q,"url":"https://github.com/dwit/api/commit/%s",
		"timestamp":"2026-10-08T10:00:00Z","author":{"name":"Ana","username":"ana"}}]}`, branch, sha, msg, sha)
}

func prEvent(action, state string, draft, merged bool, title, head, updated string) string {
	return fmt.Sprintf(`{"action":%q,"number":3,"repository":{"id":100,"full_name":"dwit/api"},
		"pull_request":{"title":%q,"body":"","html_url":"https://github.com/dwit/api/pull/3",
		"state":%q,"draft":%v,"merged":%v,"created_at":"2026-10-08T09:00:00Z","updated_at":%q,
		"user":{"login":"ana"},"head":{"ref":%q,"sha":"abc1234def5678abc1234def5678abc1234def56"},
		"base":{"ref":"main"}}}`, action, title, state, draft, merged, updated, head)
}

// Un push a una rama `cac-12-…` enlaza la rama y el commit a la tarea 12 **sin
// escribir en su hilo**.
//
// El mutante que mata: comentar también por la rama. Cada push a la rama de
// una tarea llenaría su hilo de líneas que el panel ya enseña.
func TestAPushOnATaskBranchLinksWithoutCommenting(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", pushOn("cac-12-login", sha1, "wip"))

	if b := f.links("it-1", domain.GitLinkBranch); len(b) != 1 || b[0].Key != "cac-12-login" || b[0].State != domain.BranchActive {
		t.Fatalf("la rama no quedó enlazada: %+v", b)
	}
	if c := f.links("it-1", domain.GitLinkCommit); len(c) != 1 || c[0].Via != domain.GitViaBranch {
		t.Fatalf("el commit no quedó enlazado por la rama: %+v", c)
	}
	if n := len(f.comments("it-1")); n != 0 {
		t.Fatalf("un push a la rama escribió %d líneas en el hilo", n)
	}
	// Y la de la otra org con el mismo número no se entera.
	if b := f.links("it-2", domain.GitLinkBranch); len(b) != 0 {
		t.Fatal("la rama se enlazó a la tarea 12 de otra organización")
	}
}

// La PR sigue su estado en el panel, y el hilo sólo cuenta que se enlazó y que
// se fusionó.
//
// Los mutantes que mata: comentar en cada cambio de estado (más de dos
// líneas), y no guardar el estado (el panel diría «abierta» de una fusionada).
func TestAPullRequestKeepsItsStateWithTwoLinesAtMost(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	// Por la rama, sin la tarea en el título.
	f.hook(t, "pull_request", "d-1", prEvent("opened", "open", true, false, "login", "cac-12-login", "2026-10-08T09:00:00Z"))
	f.hook(t, "pull_request", "d-2", prEvent("ready_for_review", "open", false, false, "login", "cac-12-login", "2026-10-08T09:10:00Z"))
	if p := f.links("it-1", domain.GitLinkPR); len(p) != 1 || p[0].State != domain.PRStateOpen {
		t.Fatalf("la PR lista no salió abierta: %+v", p)
	}
	f.hook(t, "pull_request", "d-3", prEvent("synchronize", "open", false, false, "login", "cac-12-login", "2026-10-08T09:20:00Z"))
	f.hook(t, "pull_request", "d-4", prEvent("closed", "closed", false, true, "login", "cac-12-login", "2026-10-08T09:30:00Z"))
	p := f.links("it-1", domain.GitLinkPR)
	if len(p) != 1 || p[0].State != domain.PRStateMerged || p[0].Via != domain.GitViaBranch {
		t.Fatalf("la PR fusionada: %+v", p)
	}
	if n := len(f.comments("it-1")); n != 2 {
		t.Fatalf("%d líneas en el hilo; se esperaban 2 (enlazada y fusionada)", n)
	}
}

// Una entrega vieja que llega después no deshace el merge.
//
// El mutante que mata: quitar la guarda de `github_updated_at` en el upsert.
func TestALateDeliveryDoesNotUndoAMerge(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "pull_request", "d-1", prEvent("closed", "closed", false, true, "login cac#12", "x", "2026-10-08T10:00:00Z"))
	f.hook(t, "pull_request", "d-2", prEvent("synchronize", "open", false, false, "login cac#12", "x", "2026-10-08T09:00:00Z"))
	if p := f.links("it-1", domain.GitLinkPR); len(p) != 1 || p[0].State != domain.PRStateMerged {
		t.Fatalf("una entrega vieja devolvió la PR a %+v", p)
	}
}

// La misma entrega dos veces es una fila y una línea.
func TestARedeliveredPullRequestIsOneLink(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	body := prEvent("opened", "open", false, false, "login cac#12", "x", "2026-10-08T09:00:00Z")
	f.hook(t, "pull_request", "d-1", body)
	f.hook(t, "pull_request", "d-1", body)
	if p := f.links("it-1", domain.GitLinkPR); len(p) != 1 {
		t.Fatalf("%d filas de la misma PR", len(p))
	}
	if n := len(f.comments("it-1")); n != 1 {
		t.Fatalf("%d líneas de una sola entrega", n)
	}
}

// Borrar la rama la deja marcada como borrada, sin quitarla del panel.
func TestDeletingABranchMarksItDeleted(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", pushOn("cac-12-login", sha1, "wip"))
	f.hook(t, "push", "d-2", `{"ref":"refs/heads/cac-12-login","deleted":true,"repository":{"id":100,"full_name":"dwit/api"},"commits":[]}`)
	if b := f.links("it-1", domain.GitLinkBranch); len(b) != 1 || b[0].State != domain.BranchDeleted {
		t.Fatalf("la rama borrada: %+v", b)
	}
}

// Un repo sin enlazar a un espacio no enlaza nada, aunque la rama nombre una tarea.
func TestAnUnlinkedRepoLinksNothing(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	// Un folio, que no depende del espacio: con `cac-12`, un repo sin espacio
	// no resolvería nada aunque la guarda faltara.
	body := fmt.Sprintf(`{"ref":"refs/heads/acme-7-x","repository":{"id":200,"full_name":"dwit/web"},
		"commits":[{"id":%q,"message":"x","url":"https://github.com/dwit/web/commit/1","author":{"name":"A"}}]}`, sha1)
	f.hook(t, "push", "d-1", body)
	var n int64
	f.db.Model(&domain.TaskGitLink{}).Count(&n)
	if n != 0 {
		t.Fatalf("un repo sin enlazar dejó %d enlaces", n)
	}
}

// El resumen del tablero y del detalle sale de las mismas filas.
func TestTheBoardSummaryCountsLinks(t *testing.T) {
	f, cleanup := githubSetup(t)
	defer cleanup()
	f.hook(t, "push", "d-1", pushOn("cac-12-login", sha1, "wip"))
	f.hook(t, "pull_request", "d-2", prEvent("opened", "open", false, false, "login", "cac-12-login", "2026-10-08T09:00:00Z"))
	s := repository.GitSummaries(f.db, []string{"it-1", "it-3"})["it-1"]
	if s.Branches != 1 || s.PRs != 1 || s.Commits != 1 || s.PRBadge != domain.PRStateOpen {
		t.Fatalf("resumen: %+v", s)
	}
	links, err := repository.GitLinksOf(f.db, "it-1")
	if err != nil || links == nil || links.Summary != s {
		t.Fatalf("el detalle no cuadra con el tablero: %+v %v", links, err)
	}
}
