package middleware

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

const bearerPrefix = "Bearer "

// Logger logs method, path, status and duration of each request.
func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(ww, r)
		log.Printf("[%s] %s %d %v", r.Method, r.RequestURI, ww.statusCode, time.Since(start))
	})
}

// CORS adds permissive CORS headers (suitable for local Tauri app). The public
// ingest endpoint is exempt: it does per-project CORS (allowed_origins) itself.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/ingest/") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Recovery catches panics and responds with 500.
func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Printf("PANIC: %v\n%s", err, debug.Stack())
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `{"success":false,"message":"internal server error"}`)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// AuthMiddleware validates the JWT access token and injects claims into context.
// PATAuthenticator resolves a plaintext personal access token into claims. It's
// injected at route-setup time (the middleware itself has no DB handle).
type PATAuthenticator func(token string) (*domain.ClaimsJWT, error)

var patAuth PATAuthenticator

// UsePATAuthenticator wires PAT support into AuthMiddleware.
func UsePATAuthenticator(fn PATAuthenticator) { patAuth = fn }

func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, bearerPrefix) {
			handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "missing-token")
			return
		}

		tokenString := strings.TrimPrefix(authHeader, bearerPrefix)

		// Personal access tokens are read-only unless a scope says otherwise, and
		// a scope opens exactly one endpoint — not "writes". Everything else,
		// including minting or revoking tokens, stays refused.
		if strings.HasPrefix(tokenString, repository.PATPrefix) {
			if patAuth == nil {
				handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "pat-unsupported")
				return
			}
			claims, err := patAuth(tokenString)
			if err != nil {
				handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
				return
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				needed, ok := patScopeFor(r)
				if !ok {
					handler.SendErrorResponse(w, http.StatusForbidden,
						"This endpoint is not available to personal access tokens", "endpoint-not-scoped")
					return
				}
				if !claims.HasScope(needed) {
					// Naming the scope is the difference between a dead end and a
					// fix: "invalid token" and "token lacks a permission" are
					// otherwise indistinguishable to the caller.
					handler.SendErrorResponse(w, http.StatusForbidden,
						"Token is missing the "+needed+" scope", "missing-scope:"+needed)
					return
				}
			}
			ctx := context.WithValue(r.Context(), repository.UserContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		claims, err := repository.ValidateAccessToken(tokenString)
		if err != nil {
			handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", err.Error())
			return
		}

		ctx := context.WithValue(r.Context(), repository.UserContextKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RefreshMiddleware validates the JWT refresh token and injects claims into context.
func RefreshMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, bearerPrefix) {
			handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "missing-token")
			return
		}

		tokenString := strings.TrimPrefix(authHeader, bearerPrefix)
		claims, err := repository.ValidateRefreshToken(tokenString)
		if err != nil {
			handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", err.Error())
			return
		}

		ctx := context.WithValue(r.Context(), repository.AccessRefreshKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetUser extracts ClaimsJWT from context (helper for protected handlers).
func GetUser(r *http.Request) (*domain.ClaimsJWT, bool) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	return claims, ok
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Flush passes through so SSE (text/event-stream) can stream through the
// logging wrapper.
func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap exposes the underlying ResponseWriter so http.ResponseController
// (SetWriteDeadline etc.) can reach it — without this the SSE handler's attempt
// to clear the server WriteTimeout silently no-ops and the stream dies at 15s.
func (rw *responseWriter) Unwrap() http.ResponseWriter {
	return rw.ResponseWriter
}

// Every mutation a personal access token can reach, and the scope it needs.
// Patterns, not prefixes: each entry is one endpoint, so granting a scope can
// never widen into something nobody reviewed. Anything absent stays refused —
// including minting tokens, deleting, and everything outside tasks.
var patWritable = []struct {
	method string
	path   *regexp.Regexp
	scope  string
}{
	// Append-only.
	{http.MethodPost, regexp.MustCompile(`^/api/v1/task-lists/[^/]+/tasks/?$`), domain.ScopeTasksWrite},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/tasks/[^/]+/comments/?$`), domain.ScopeTasksWrite},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/notes/?$`), domain.ScopeNotesWrite},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/reports/[^/]+/comments/?$`), domain.ScopeReportsWrite},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/reports/[^/]+/images/?$`), domain.ScopeReportsWrite},
	// Changes what already exists.
	{http.MethodPatch, regexp.MustCompile(`^/api/v1/tasks/[^/]+$`), domain.ScopeTasksManage},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/tasks/[^/]+/move/?$`), domain.ScopeTasksManage},
	{http.MethodPatch, regexp.MustCompile(`^/api/v1/notes/[^/]+$`), domain.ScopeNotesManage},
	{http.MethodPatch, regexp.MustCompile(`^/api/v1/reports/[^/]+$`), domain.ScopeReportsManage},
	{http.MethodDelete, regexp.MustCompile(`^/api/v1/reports/[^/]+/images/[^/]+$`), domain.ScopeReportsManage},
}

// patScopeFor reports the scope this request needs, and whether it's reachable
// by a token at all.
func patScopeFor(r *http.Request) (string, bool) {
	for _, e := range patWritable {
		if r.Method == e.method && e.path.MatchString(r.URL.Path) {
			return e.scope, true
		}
	}
	return "", false
}
