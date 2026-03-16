package middleware

import (
	"context"
	"fmt"
	"log"
	"net/http"
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

// CORS adds permissive CORS headers (suitable for local Tauri app).
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, bearerPrefix) {
			handler.SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "missing-token")
			return
		}

		tokenString := strings.TrimPrefix(authHeader, bearerPrefix)
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
