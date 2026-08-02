package middleware

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ProjectKeyResolver turns a plaintext ingest key into the project it belongs
// to. Injected at route-setup time so this package keeps no DB handle.
type ProjectKeyResolver func(key string) (*domain.ReportProject, error)

// ReportKeyOrAuth authenticates the report console API with **either** a person
// (JWT / personal access token, the existing path) **or** a project's own ingest
// key.
//
// Why a project key at all: a tenant app driving its own board is not a person.
// Representing it as one means inventing an account, storing a password, and
// handing it every project its organization owns. A project key is the smaller
// credential — it names exactly one project, it already exists, and the console
// can already rotate it.
//
// Only for `platform: "app"` projects, and this is the load-bearing part. A
// "web" project's key ships inside the widget, and the Origin allowlist that
// guards it is skipped entirely for requests that send no Origin header
// (see ingest.go) — which is every curl. That is an accepted trade for a
// write-only key whose worst case is spam against a rate limit. It would not be
// an accepted trade for reading every report the project has.
func ReportKeyOrAuth(resolve ProjectKeyResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("X-Ingest-Key")
			if key == "" {
				AuthMiddleware(next).ServeHTTP(w, r) // no key: the normal path
				return
			}

			project, err := resolve(key)
			// The empty-ID check is not paranoia about the database: ProjectID is
			// the only thing the two authorization gates read, so a blank one
			// would slip through as "a person who belongs to no organization" —
			// which fails closed, but as an empty list rather than a refusal.
			if err != nil || project == nil || project.ID == "" {
				handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-ingest-key")
				return
			}
			if project.Platform != "app" {
				handler.SendErrorResponse(w, http.StatusForbidden,
					"This project's key is public (it ships in the browser widget), so it cannot read or triage. "+
						"Use a server-to-server project, or a personal access token.",
					"key-not-server-to-server")
				return
			}
			if !projectKeyMayReach(r) {
				handler.SendErrorResponse(w, http.StatusForbidden,
					"A project key can read and triage its own reports, nothing else", "endpoint-not-key-reachable")
				return
			}

			// ProjectID is what the two authorization gates in report_admin.go
			// key off. Orgs is deliberately left empty: nothing should fall back
			// to org membership for this caller.
			claims := &domain.ClaimsJWT{
				Username:     "project:" + project.Slug,
				ProjectID:    project.ID,
				ProjectOrgID: project.OrgID,
				ProjectName:  project.Name,
				ProjectSlug:  project.Slug,
			}
			ctx := context.WithValue(r.Context(), repository.UserContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// projectKeyMayReach allows reading, triage (PATCH on the report), and replying
// — the three things running your own board consists of.
//
// Every delete stays refused, including removing an attached image: the key
// adds and reclassifies, it never erases history. Editing or deleting a comment
// is refused twice over, since the service also requires the caller to be the
// comment's author and a project key never is.
func projectKeyMayReach(r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/v1/reports") {
		return false
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		return true
	case http.MethodPatch:
		// PATCH /reports/{id} — status, assignee, taxonomy. Not comments.
		return patchReport.MatchString(r.URL.Path)
	case http.MethodPost:
		return postComment.MatchString(r.URL.Path) || postImages.MatchString(r.URL.Path)
	}
	return false
}

var (
	patchReport = regexp.MustCompile(`^/api/v1/reports/[^/]+$`)
	postComment = regexp.MustCompile(`^/api/v1/reports/[^/]+/comments/?$`)
	postImages  = regexp.MustCompile(`^/api/v1/reports/[^/]+/images/?$`)
)
