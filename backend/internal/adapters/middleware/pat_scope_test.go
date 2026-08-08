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
		{http.MethodPost, "/api/v1/tasks/abc/move", domain.ScopeTasksManage},
		{http.MethodPost, "/api/v1/notes/", domain.ScopeNotesWrite},
		// Append-only, like creating the page it hangs off.
		{http.MethodPost, "/api/v1/notes/abc/attachments", domain.ScopeNotesWrite},
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
	}
	for _, c := range cases {
		got, ok := patScopeFor(req(c.method, c.path))
		if !ok || got != c.want {
			t.Errorf("%s %s → (%q, %v), want %q", c.method, c.path, got, ok, c.want)
		}
	}
}

// A token that can add things must not be able to change or destroy them.
func TestAppendScopeCannotChangeExistingWork(t *testing.T) {
	for _, path := range []string{
		"/api/v1/tasks/abc", "/api/v1/tasks/abc/move", "/api/v1/tasks/abc/comments/xyz",
	} {
		scope, _ := patScopeFor(req(http.MethodPatch, path))
		if scope == domain.ScopeTasksWrite {
			t.Errorf("%s must not be reachable with the append-only scope", path)
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
		req(http.MethodDelete, "/api/v1/tasks/abc"),
		req(http.MethodDelete, "/api/v1/task-lists/abc/tasks"),
		req(http.MethodPost, "/api/v1/task-lists/abc/tasks/extra"),
		req(http.MethodPost, "/api/v1/task-lists/abc/statuses"),
		req(http.MethodPost, "/api/v1/users/"),
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
