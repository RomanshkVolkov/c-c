package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

func req(method, path string) *http.Request {
	return httptest.NewRequest(method, path, nil)
}

// Each endpoint asks for the scope that matches what it can destroy: adding a
// task or a comment is append-only, changing one is not.
func TestEachEndpointAsksForTheRightScope(t *testing.T) {
	cases := []struct {
		method, path, want string
	}{
		{http.MethodPost, "/api/v1/task-lists/abc-123/tasks", domain.ScopeTasksWrite},
		// The tree a task lives in. Adding to it is append-only; removing from
		// it is not on the allowlist at all.
		{http.MethodPost, "/api/v1/task-spaces/", domain.ScopeTasksWrite},
		{http.MethodPost, "/api/v1/task-spaces/abc/folders", domain.ScopeTasksWrite},
		{http.MethodPost, "/api/v1/task-spaces/abc/lists", domain.ScopeTasksWrite},
		{http.MethodPost, "/api/v1/tasks/abc/comments", domain.ScopeTasksWrite},
		{http.MethodPatch, "/api/v1/tasks/abc", domain.ScopeTasksManage},
		// Renaming a list or a space, and pointing one at a tenant's channel.
		// Manage rather than write: the binding decides whether work created there
		// shows up on a client's board, which is changing something, not adding to
		// it. The same-organization check in the repository is what stops it
		// reaching a tenant nobody here works with.
		{http.MethodPatch, "/api/v1/task-lists/abc", domain.ScopeTasksManage},
		{http.MethodPatch, "/api/v1/task-spaces/abc", domain.ScopeTasksManage},
		{http.MethodPost, "/api/v1/tasks/abc/move", domain.ScopeTasksManage},
		// Reclamar: se pide desde el MCP (update_task claim) con un token.
		{http.MethodPost, "/api/v1/tasks/abc/claim", domain.ScopeTasksManage},
		{http.MethodPost, "/api/v1/notes/", domain.ScopeNotesWrite},
		// Append-only, like creating the page it hangs off.
		{http.MethodPost, "/api/v1/notes/abc/attachments", domain.ScopeNotesWrite},
		// Y a una tarea, con el permiso de escribir tareas (MCP add_task_attachment).
		{http.MethodPost, "/api/v1/tasks/abc/attachments", domain.ScopeTasksWrite},
		// Enlazar a mano una PR a una tarea: añade, no pisa.
		{http.MethodPost, "/api/v1/tasks/abc/git/prs", domain.ScopeTasksWrite},
		{http.MethodPatch, "/api/v1/notes/abc", domain.ScopeNotesManage},
		{http.MethodPost, "/api/v1/reports/abc/comments", domain.ScopeReportsWrite},
		{http.MethodPost, "/api/v1/reports/abc/images", domain.ScopeReportsWrite},
		{http.MethodPatch, "/api/v1/reports/abc", domain.ScopeReportsManage},
		{http.MethodDelete, "/api/v1/reports/abc/images/xyz", domain.ScopeReportsManage},
		// Overwriting what was said, so manage and not write. The author check
		// in the service is what keeps this to the token holder's own words.
		{http.MethodPatch, "/api/v1/reports/abc/comments/xyz", domain.ScopeReportsManage},
		{http.MethodDelete, "/api/v1/reports/abc/comments/xyz", domain.ScopeReportsManage},
		{http.MethodPatch, "/api/v1/tasks/abc/comments/xyz", domain.ScopeTasksManage},
		{http.MethodDelete, "/api/v1/tasks/abc/comments/xyz", domain.ScopeTasksManage},
		{http.MethodPost, "/api/v1/collections/", domain.ScopeCollectionsWrite},
		// Documentación. Añadir al final y registrar una decisión sólo agregan:
		// `append` concatena en la base sin leer antes, así que no puede pisar a
		// quien esté escribiendo, y el registro es append-only por diseño.
		{http.MethodPost, "/api/v1/docs/list/abc/tabs/runbook/append", domain.ScopeDocsWrite},
		{http.MethodPost, "/api/v1/docs/space/abc/decisions", domain.ScopeDocsWrite},
		// Pedir una revisión sólo añade (#92): con `docs:write`, no `docs:manage`.
		{http.MethodPost, "/api/v1/docs/list/abc/review-request", domain.ScopeDocsWrite},
		// Páginas: crear y añadir sólo añaden; pisar, mover, papelera y
		// restaurar cambian lo que hay.
		{http.MethodPost, "/api/v1/docs/list/abc/pages", domain.ScopeDocsWrite},
		{http.MethodPost, "/api/v1/docs/list/abc/pages/p1/append", domain.ScopeDocsWrite},
		{http.MethodPut, "/api/v1/docs/list/abc/pages/p1", domain.ScopeDocsManage},
		{http.MethodPost, "/api/v1/docs/list/abc/pages/p1/move", domain.ScopeDocsManage},
		{http.MethodDelete, "/api/v1/docs/list/abc/pages/p1", domain.ScopeDocsManage},
		{http.MethodPost, "/api/v1/docs/list/abc/pages/p1/restore", domain.ScopeDocsManage},
		{http.MethodPost, "/api/v1/docs/list/abc/pages/p1/versions/v1/restore", domain.ScopeDocsManage},
		// Reemplazar una sección entera, y poner dueño o línea fijada.
		{http.MethodPut, "/api/v1/docs/list/abc/tabs/overview", domain.ScopeDocsManage},
		{http.MethodPatch, "/api/v1/docs/folder/abc", domain.ScopeDocsManage},
		// Configurar el despliegue de un servicio (16-oct-2026): registrar uno,
		// editarlo y poner sus secrets por nombre.
		{http.MethodPost, "/api/v1/servers/s1/deployables", domain.ScopeDeploysManage},
		{http.MethodPatch, "/api/v1/servers/s1/deployables/d1", domain.ScopeDeploysManage},
		{http.MethodPut, "/api/v1/servers/s1/deployables/d1/secret-refs", domain.ScopeDeploysManage},
		// Avisarse a uno mismo (#153). La ruta no lleva destinatario.
		{http.MethodPost, "/api/v1/notifications/self", domain.ScopeNotifyMe},
		// El muro (#189): publicar, subir la imagen que se cita, comentar y
		// reaccionar. Todo añade.
		{http.MethodPost, "/api/v1/posts", domain.ScopePostsWrite},
		{http.MethodPost, "/api/v1/posts/attachments", domain.ScopePostsWrite},
		{http.MethodPost, "/api/v1/posts/p1/comments", domain.ScopePostsWrite},
		{http.MethodPost, "/api/v1/posts/p1/reactions", domain.ScopePostsWrite},
		{http.MethodPost, "/api/v1/posts/p1/comments/c1/reactions", domain.ScopePostsWrite},
		// Canales y directos (22-oct-2026): escribir y abrir el directo.
		{http.MethodPost, "/api/v1/task-spaces/s1/chat", domain.ScopeChatWrite},
		{http.MethodPost, "/api/v1/dm/open", domain.ScopeChatWrite},
		{http.MethodPost, "/api/v1/dm/c1/messages", domain.ScopeChatWrite},
	}
	for _, c := range cases {
		got, ok := patScopeFor(req(c.method, c.path))
		if !ok || got != c.want {
			t.Errorf("%s %s → (%q, %v), want %q", c.method, c.path, got, ok, c.want)
		}
	}
}

// Escribir en el chat no es editar ni retirar lo dicho, ni reaccionar ni
// mover la marca de leído de nadie (22-oct-2026).
func TestChatWriteOnlyAdds(t *testing.T) {
	for _, c := range []struct{ method, path string }{
		{http.MethodPatch, "/api/v1/task-spaces/s1/chat/m1"},
		{http.MethodDelete, "/api/v1/task-spaces/s1/chat/m1"},
		{http.MethodPost, "/api/v1/task-spaces/s1/chat/m1/reactions"},
		{http.MethodPatch, "/api/v1/dm/c1/messages/m1"},
		{http.MethodDelete, "/api/v1/dm/c1/messages/m1"},
		{http.MethodPost, "/api/v1/dm/c1/read"},
	} {
		if scope, ok := patScopeFor(req(c.method, c.path)); ok && scope == domain.ScopeChatWrite {
			t.Errorf("%s %s no puede abrirse con chat:write", c.method, c.path)
		}
	}
	if !domain.ValidScope(domain.ScopeChatWrite) {
		t.Fatal("chat:write tiene que poder pedirse al crear un token")
	}
}

// A token that can add things must not be able to change or destroy them.
func TestAppendScopeCannotChangeExistingWork(t *testing.T) {
	for _, path := range []string{
		"/api/v1/tasks/abc", "/api/v1/tasks/abc/move", "/api/v1/tasks/abc/comments/xyz",
		// An append-only token must not be able to point a list at a client's
		// board: that publishes work, it doesn't add any.
		"/api/v1/task-lists/abc", "/api/v1/task-spaces/abc",
	} {
		scope, _ := patScopeFor(req(http.MethodPatch, path))
		if scope == domain.ScopeTasksWrite {
			t.Errorf("%s must not be reachable with the append-only scope", path)
		}
	}
	// Lo mismo en documentación: reemplazar una sección borra lo que hubiera, y
	// poner dueño cambia de quién es. Ninguna de las dos es añadir.
	for _, c := range []struct{ method, path string }{
		{http.MethodPut, "/api/v1/docs/list/abc/tabs/overview"},
		{http.MethodPatch, "/api/v1/docs/list/abc"},
	} {
		scope, _ := patScopeFor(req(c.method, c.path))
		if scope == domain.ScopeDocsWrite {
			t.Errorf("%s %s must not be reachable with the append-only scope", c.method, c.path)
		}
	}
}

// Everything not on the allowlist stays out of reach for any token, scoped or
// not — deleting, minting tokens, creating users, touching the hierarchy.
//
// `POST /task-spaces/` moved out too: building the tree is adding, and an
// agent that can write tasks but not the list to put them in is half a tool.
//
// `PATCH /tasks/{id}/comments/{id}` used to be on this list and deliberately
// so. It moved out for the same reason the report one did: a token is the
// person, the handler still refuses anyone else's comment, and leaving it here
// meant someone could fix a typo in the app but not through their own token.
func TestUnlistedEndpointsAreUnreachable(t *testing.T) {
	unreachable := []*http.Request{
		req(http.MethodPost, "/api/v1/auth/tokens"),
		// The one that matters most: a token must not be able to widen its own
		// permissions. Re-permissioning takes a real session.
		req(http.MethodPatch, "/api/v1/auth/tokens/abc"),
		req(http.MethodDelete, "/api/v1/auth/tokens/abc"),
		req(http.MethodDelete, "/api/v1/tasks/abc"),
		// Adjuntar sí; quitar un adjunto, no.
		req(http.MethodDelete, "/api/v1/tasks/abc/attachments/a1"),
		req(http.MethodDelete, "/api/v1/task-lists/abc/tasks"),
		req(http.MethodPost, "/api/v1/task-lists/abc/tasks/extra"),
		req(http.MethodPost, "/api/v1/task-lists/abc/statuses"),
		req(http.MethodPost, "/api/v1/users/"),
		// Creating a collection is allowed; everything that touches one that
		// already exists — or hands it to someone else — is not.
		req(http.MethodDelete, "/api/v1/collections/abc"),
		req(http.MethodPost, "/api/v1/collections/abc/shares"),
		req(http.MethodDelete, "/api/v1/collections/abc/shares/u1"),
		req(http.MethodPut, "/api/v1/docs/space/abc"),
		req(http.MethodDelete, "/api/v1/notes/abc"),
		req(http.MethodPut, "/api/v1/notes/tree"),
		// Removing someone's report outright is still nobody's to do with a
		// token — unlike a comment, which the author may withdraw.
		req(http.MethodDelete, "/api/v1/reports/abc"),
		req(http.MethodPost, "/api/v1/report-projects/"),
		// Emptying the trash and purging are irreversible; no scope reaches them.
		req(http.MethodDelete, "/api/v1/notes/trash"),
		req(http.MethodDelete, "/api/v1/notes/trash/abc"),
		req(http.MethodPost, "/api/v1/notes/trash/abc/restore"),
		// Del muro, con token sólo se añade: publicar un borrador (que es lo
		// que un borrador existe para dejarle a una persona), editar, fijar y
		// borrar, no.
		req(http.MethodPost, "/api/v1/posts/p1/publish"),
		req(http.MethodPatch, "/api/v1/posts/p1"),
		req(http.MethodPost, "/api/v1/posts/p1/pin"),
		req(http.MethodDelete, "/api/v1/posts/p1"),
		req(http.MethodDelete, "/api/v1/posts/p1/comments/c1"),
	}
	for _, r := range unreachable {
		if _, ok := patScopeFor(r); ok {
			t.Errorf("%s %s must not be reachable by a token", r.Method, r.URL.Path)
		}
	}
}

// Reading needs no scope at all — the middleware only consults the allowlist
// for non-GET. This is the property that lets another app back its "my reports"
// view and its board with a plain read-only token, instead of a username and a
// password it has to store, refresh and rotate by hand.
func TestReadingNeedsNoScope(t *testing.T) {
	for _, path := range []string{
		"/api/v1/reports/",
		"/api/v1/reports/abc",
		"/api/v1/reports/transitions",
		"/api/v1/reports/taxonomy",
	} {
		if _, ok := patScopeFor(req(http.MethodGet, path)); ok {
			t.Errorf("GET %s should not be in the write allowlist at all", path)
		}
	}
}

// The shared access logger writes the request URI, and several endpoints take a
// credential in the query because the browser API fetching them cannot set a
// header (EventSource, <img>). Without redaction every one of those lands in
// the log in clear text — latent rather than absent, since it only appears once
// those endpoints are actually used.
func TestTheAccessLogNeverWritesACredential(t *testing.T) {
	for _, c := range []struct{ in, leaked string }{
		{"/api/v1/events?token=secret-abc", "secret-abc"},
		{"/api/v1/notes/n1/attachments/a1/raw?token=secret-abc", "secret-abc"},
		{"/api/v1/reports/r1/images/i1?sig=secret-sig&exp=1", "secret-sig"},
		{"/ingest/v1/reports/r1/comments?token=secret-abc", "secret-abc"},
	} {
		got := redactQuery(c.in)
		if strings.Contains(got, c.leaked) {
			t.Errorf("redactQuery(%q) = %q — still leaks the credential", c.in, got)
		}
		if !strings.Contains(got, "REDACTED") {
			t.Errorf("redactQuery(%q) = %q, want the value replaced", c.in, got)
		}
	}

	// Ordinary URLs must survive untouched, or debugging gets worse.
	for _, in := range []string{
		"/api/v1/reports/",
		"/api/v1/reports/?status=open&limit=50",
		"/api/v1/notes/n1",
	} {
		if got := redactQuery(in); got != in {
			t.Errorf("redactQuery(%q) = %q, want it unchanged", in, got)
		}
	}

	// A query we can't parse is dropped rather than logged hopefully.
	if got := redactQuery("/x?%zz"); strings.Contains(got, "%zz") {
		t.Errorf("unparseable query should not be logged verbatim, got %q", got)
	}
}

// Un token configura un servicio; **no** lo despliega, ni vuelve atrás, ni lo
// borra, ni saca la llave del CI. Mutante: abrir alguna de éstas a un token.
func TestATokenConfiguresButNeverDeploys(t *testing.T) {
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/servers/s1/deployables/d1/deploy"},
		{http.MethodPost, "/api/v1/servers/s1/deployables/d1/deployments/x/rollback"},
		{http.MethodDelete, "/api/v1/servers/s1/deployables/d1"},
		{http.MethodPost, "/api/v1/servers/s1/deployables/d1/ci-key"},
		{http.MethodPost, "/api/v1/servers/s1/deployables/d1/secret-rotations"},
		{http.MethodPatch, "/api/v1/servers/s1"},
	} {
		if scope, ok := patScopeFor(req(c.method, c.path)); ok {
			t.Errorf("%s %s se abrió a un token (%s)", c.method, c.path, scope)
		}
	}
}
