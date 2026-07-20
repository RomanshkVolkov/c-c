package handler

import (
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// ─── in-memory per-project rate limiter ───────────────────────────────────────
//
// Sliding 1h window keyed by project id. Good enough for the expected volume
// (dozens/day); if the backend scales to multiple replicas this becomes a soft
// per-pod limit — revisit with a shared store only if abuse appears.
type ingestLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newIngestLimiter() *ingestLimiter {
	return &ingestLimiter{hits: make(map[string][]time.Time)}
}

func (l *ingestLimiter) allow(key string, perHour int) bool {
	if perHour <= 0 {
		perHour = 20
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-time.Hour)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= perHour {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, time.Now())
	return true
}

// ─── handler ──────────────────────────────────────────────────────────────────

type IngestHandler interface {
	CreateReport(w http.ResponseWriter, r *http.Request)
	Preflight(w http.ResponseWriter, r *http.Request)
}

type ingestHandler struct {
	projects *repository.ReportProjectRepository
	svc      *service.ReportService
	limiter  *ingestLimiter
}

func NewIngestHandler(projects *repository.ReportProjectRepository, svc *service.ReportService) IngestHandler {
	return &ingestHandler{projects: projects, svc: svc, limiter: newIngestLimiter()}
}

// Preflight answers CORS preflight. The project isn't known yet (no key on a
// preflight), so it echoes the Origin permissively; the actual POST enforces
// the project's allowed_origins.
func (h *ingestHandler) Preflight(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Ingest-Key")
	w.Header().Set("Access-Control-Max-Age", "3600")
	w.WriteHeader(http.StatusNoContent)
}

func (h *ingestHandler) CreateReport(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("X-Ingest-Key")
	if key == "" {
		SendErrorResponse(w, http.StatusUnauthorized, "Missing ingest key", "no-key")
		return
	}
	project, err := h.projects.FindActiveByIngestKey(key)
	if err != nil {
		// Same response for unknown/inactive keys — don't leak which.
		SendErrorResponse(w, http.StatusUnauthorized, "Invalid ingest key", "invalid-key")
		return
	}

	// Origin enforcement + CORS echo (server-side, not just headers).
	origin := r.Header.Get("Origin")
	allowed := []string(project.AllowedOrigins)
	if origin != "" && len(allowed) > 0 && !slices.Contains(allowed, origin) {
		SendErrorResponse(w, http.StatusForbidden, "Origin not allowed", "origin-not-allowed")
		return
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}

	if !h.limiter.allow(project.ID, project.RateLimitPerHour) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Rate limit exceeded", "rate-limited")
		return
	}

	images, ok := readMultipartImages(w, r, "images")
	if !ok {
		return
	}

	title := r.FormValue("title")
	if title == "" {
		SendErrorResponse(w, http.StatusBadRequest, "Title is required", "title-required")
		return
	}

	in := domain.IngestReportInput{
		Title:         title,
		Description:   r.FormValue("description"),
		URL:           r.FormValue("url"),
		UserAgent:     r.FormValue("userAgent"),
		Viewport:      r.FormValue("viewport"),
		ReporterName:  r.FormValue("reporterName"),
		ReporterEmail: r.FormValue("reporterEmail"),
		Origin:        r.FormValue("origin"), // "system" enables title dedup
		Images:        images,
	}

	result, err := h.svc.Ingest(r.Context(), project, in)
	if err != nil {
		if errors.Is(err, service.ErrImagesUnavailable) {
			SendErrorResponse(w, http.StatusServiceUnavailable, "Image storage unavailable", err.Error())
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create report", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.IngestReportResult]{Success: true, Data: result})
}
