package service

import (
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Editing a token's permissions goes through the same sanitizer as minting one.
//
// That matters more here than at mint: a token that already exists is in use
// somewhere, and an unknown string persisted into its scope list would read as
// "granted" to any future check looking for that name. Two doors into the same
// field need the same lock.
func TestScopesAreSanitizedTheSameWayOnBothPaths(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"unknown scopes are dropped, not stored", []string{"tasks:write", "admin:*", "delete:everything"}, "tasks:write"},
		{"duplicates collapse", []string{"notes:write", "notes:write"}, "notes:write"},
		{"whitespace doesn't smuggle one past", []string{"  reports:manage  "}, "reports:manage"},
		{"an empty request means read-only", []string{}, ""},
		{"a made-up scope alone leaves it read-only", []string{"superadmin"}, ""},
		{"the real ones survive together", []string{
			"tasks:write", "tasks:manage", "notes:write", "notes:manage",
			"reports:write", "reports:manage", "collections:write",
		}, "tasks:write,tasks:manage,notes:write,notes:manage,reports:write,reports:manage,collections:write"},
	}
	for _, c := range cases {
		if got := sanitizeScopes(c.in); got != c.want {
			t.Errorf("%s: sanitizeScopes(%v) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

// Every scope the app can offer has to be one the backend recognizes. A typo in
// either list would mint a token whose permission silently does nothing.
func TestEveryDefinedScopeIsValid(t *testing.T) {
	all := []string{
		domain.ScopeTasksWrite, domain.ScopeTasksManage,
		domain.ScopeNotesWrite, domain.ScopeNotesManage,
		domain.ScopeReportsWrite, domain.ScopeReportsManage,
		domain.ScopeCollectionsWrite,
	}
	for _, s := range all {
		if !domain.ValidScope(s) {
			t.Errorf("%q is defined but ValidScope rejects it", s)
		}
		if !strings.Contains(s, ":") {
			t.Errorf("%q doesn't follow resource:verb", s)
		}
	}
}

// The round trip a re-permissioned token takes: stored joined, read back split.
// An empty string has to come back as no scopes rather than one blank scope,
// or "read-only" would look like a token holding a permission named "".
func TestStoredScopesRoundTrip(t *testing.T) {
	if got := splitScopes(sanitizeScopes(nil)); got != nil {
		t.Errorf("no scopes should read back as nil, got %#v", got)
	}
	stored := sanitizeScopes([]string{"tasks:write", "reports:manage"})
	got := splitScopes(stored)
	if len(got) != 2 || got[0] != "tasks:write" || got[1] != "reports:manage" {
		t.Errorf("round trip lost something: %#v", got)
	}
}
