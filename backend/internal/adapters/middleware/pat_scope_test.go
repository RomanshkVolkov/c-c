package middleware

import (
	"net/http"
	"net/http/httptest"
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
		{http.MethodPost, "/api/v1/tasks/abc/comments", domain.ScopeTasksWrite},
		{http.MethodPatch, "/api/v1/tasks/abc", domain.ScopeTasksManage},
		{http.MethodPost, "/api/v1/tasks/abc/move", domain.ScopeTasksManage},
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
	for _, path := range []string{"/api/v1/tasks/abc", "/api/v1/tasks/abc/move"} {
		scope, _ := patScopeFor(req(http.MethodPatch, path))
		if scope == domain.ScopeTasksWrite {
			t.Errorf("%s must not be reachable with the append-only scope", path)
		}
	}
}

// Everything not on the allowlist stays out of reach for any token, scoped or
// not — deleting, minting tokens, creating users, touching the hierarchy.
func TestUnlistedEndpointsAreUnreachable(t *testing.T) {
	unreachable := []*http.Request{
		req(http.MethodPost, "/api/v1/auth/tokens"),
		req(http.MethodDelete, "/api/v1/tasks/abc"),
		req(http.MethodDelete, "/api/v1/task-lists/abc/tasks"),
		req(http.MethodPost, "/api/v1/task-lists/abc/tasks/extra"),
		req(http.MethodPost, "/api/v1/task-lists/abc/statuses"),
		req(http.MethodPost, "/api/v1/task-spaces/"),
		req(http.MethodPost, "/api/v1/users/"),
		req(http.MethodPut, "/api/v1/docs/space/abc"),
		req(http.MethodPatch, "/api/v1/tasks/abc/comments/xyz"),
	}
	for _, r := range unreachable {
		if _, ok := patScopeFor(r); ok {
			t.Errorf("%s %s must not be reachable by a token", r.Method, r.URL.Path)
		}
	}
}
