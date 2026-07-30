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

// The scope opens one endpoint. Everything else a token could reach — editing,
// deleting, moving, minting another token — must stay refused even with it.
func TestScopeOpensOnlyTaskCreation(t *testing.T) {
	scoped := &domain.ClaimsJWT{Scopes: []string{domain.ScopeTasksWrite}}

	allowed := req(http.MethodPost, "/api/v1/task-lists/abc-123/tasks")
	if !patMayWrite(allowed, scoped) {
		t.Fatal("creating a task must be allowed with the scope")
	}

	refused := []*http.Request{
		req(http.MethodPost, "/api/v1/auth/tokens"),
		req(http.MethodDelete, "/api/v1/task-lists/abc/tasks"),
		req(http.MethodPatch, "/api/v1/tasks/abc"),
		req(http.MethodPost, "/api/v1/tasks/abc/move"),
		req(http.MethodPost, "/api/v1/task-lists/abc/tasks/extra"),
		req(http.MethodPost, "/api/v1/task-lists/abc/statuses"),
		req(http.MethodPost, "/api/v1/task-spaces/"),
		req(http.MethodPost, "/api/v1/users/"),
	}
	for _, r := range refused {
		if patMayWrite(r, scoped) {
			t.Errorf("%s %s must stay refused", r.Method, r.URL.Path)
		}
	}
}

// A token without the scope — every token minted before scopes existed — writes
// nothing at all.
func TestTokenWithoutScopeWritesNothing(t *testing.T) {
	plain := &domain.ClaimsJWT{}
	if patMayWrite(req(http.MethodPost, "/api/v1/task-lists/abc/tasks"), plain) {
		t.Fatal("a token with no scopes must not create tasks")
	}
}
