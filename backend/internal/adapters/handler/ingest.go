package handler

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"strings"
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
	l.sweepLocked(cutoff)
	return true
}

// sweepLocked drops keys with no hits left in the window. The events limiter is
// keyed per device, so without this the map would grow with every device that
// ever reported. Only runs once the map is big enough to be worth it.
func (l *ingestLimiter) sweepLocked(cutoff time.Time) {
	if len(l.hits) < 512 {
		return
	}
	for k, hits := range l.hits {
		if len(hits) == 0 || hits[len(hits)-1].Before(cutoff) {
			delete(l.hits, k)
		}
	}
}

// ─── handler ──────────────────────────────────────────────────────────────────

type IngestHandler interface {
	CreateReport(w http.ResponseWriter, r *http.Request)
	CreateEvent(w http.ResponseWriter, r *http.Request)
	Preflight(w http.ResponseWriter, r *http.Request)
	ReporterView(w http.ResponseWriter, r *http.Request)
	ReporterComment(w http.ResponseWriter, r *http.Request)
	UnreadCounts(w http.ResponseWriter, r *http.Request)
}

// Passive telemetry is a different traffic shape from manual bug reports: a
// fleet of devices heartbeats continuously, so it gets its own limiter keyed
// per device (not per project) with a much higher ceiling, and a hard body cap.
const (
	maxEventBatchBytes            = 1 << 20 // 1 MiB
	defaultEventsPerHourPerDevice = 120
)

func eventsRateLimit() int {
	if v := repository.GetEnv("EVENTS_RATE_LIMIT_PER_DEVICE", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultEventsPerHourPerDevice
}

type ingestHandler struct {
	projects     *repository.ReportProjectRepository
	svc          *service.ReportService
	telemetry    *service.TelemetryService
	limiter      *ingestLimiter
	eventLimiter *ingestLimiter
}

func NewIngestHandler(projects *repository.ReportProjectRepository, svc *service.ReportService, telemetry *service.TelemetryService) IngestHandler {
	return &ingestHandler{
		projects:     projects,
		svc:          svc,
		telemetry:    telemetry,
		limiter:      newIngestLimiter(),
		eventLimiter: newIngestLimiter(),
	}
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

// allowedOrigin is the Origin rule, in one place because it has to mean the
// same thing at every door.
//
// A native project ("app") is exempt outright: there is no browser, so there is
// no Origin to check, and the console does not even show the field for one. Any
// origins stored against such a project are leftovers, and must not become a
// rule nobody can see.
//
// For a browser project an empty allowlist allows anything — that is what the
// field says.
//
// A NON-empty allowlist is law: the request must carry an Origin, and it must
// be one of them. The older version only checked requests that happened to send
// one, which made the list guard browsers and nothing else — the key is printed
// inside the widget the browser downloads, so anyone could read it and replay
// it with curl, which sends no Origin and sailed straight through. Registering
// an origin now means "only these", not "these, plus anyone not using a
// browser".
func allowedOrigin(w http.ResponseWriter, r *http.Request, project *domain.ReportProject) bool {
	if project.Platform == "app" {
		return true
	}
	allowed := []string(project.AllowedOrigins)
	if len(allowed) == 0 {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Named apart from the mismatch case: "you sent none" and "yours isn't
		// on the list" are different problems with different fixes, and the
		// caller can't see the list to tell them apart.
		SendErrorResponse(w, http.StatusForbidden,
			"This project only accepts requests from its allowed origins, and this request sent no Origin header",
			"origin-missing")
		return false
	}
	if !slices.Contains(allowed, origin) {
		SendErrorResponse(w, http.StatusForbidden, "Origin not allowed", "origin-not-allowed")
		return false
	}
	return true
}

func (h *ingestHandler) CreateReport(w http.ResponseWriter, r *http.Request) {
	// Echo the Origin up front so EVERY response (incl. 401/403/429) carries
	// ACAO — otherwise the browser masks the real status as an opaque CORS error.
	echoCORS(w, r)

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

	if !allowedOrigin(w, r, project) {
		return
	}

	if !h.limiter.allow(project.ID, project.RateLimitPerHour) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Rate limit exceeded", "rate-limited")
		return
	}
	// Then the per-person cap, so one reporter cannot spend the project's whole
	// budget. Checked second and keyed by the host app's own user id, which is
	// the only stable identity here — absent for anonymous widgets, where the
	// project ceiling is all there is.
	if id := r.FormValue("reporterId"); id != "" && project.RateLimitPerReporterPerHour > 0 {
		if !h.limiter.allow(project.ID+"/"+id, project.RateLimitPerReporterPerHour) {
			SendErrorResponse(w, http.StatusTooManyRequests,
				"You have filed too many reports in the last hour", "rate-limited-reporter")
			return
		}
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
		ReporterID:    r.FormValue("reporterId"),
		Origin:        r.FormValue("origin"), // "system" enables title dedup
		Category:      r.FormValue("category"),
		Priority:      r.FormValue("priority"),
		Area:          r.FormValue("area"),
		TelemetryJSON: r.FormValue("telemetry"),
		SnapshotJSON:  r.FormValue("snapshot"),
		ContextJSON:   r.FormValue("context"),
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

// CreateEvent — POST /ingest/v1/events : headless passive telemetry from a
// native app. Auth by X-Ingest-Key + rate limit only; NO Origin/CORS guard
// (native clients don't send Origin). The batch is re-redacted, encrypted at
// rest and stored with a TTL, separate from reports.
func (h *ingestHandler) CreateEvent(w http.ResponseWriter, r *http.Request) {
	echoCORS(w, r) // harmless for native; lets a browser client use it too

	key := r.Header.Get("X-Ingest-Key")
	if key == "" {
		SendErrorResponse(w, http.StatusUnauthorized, "Missing ingest key", "no-key")
		return
	}
	project, err := h.projects.FindActiveByIngestKey(key)
	if err != nil {
		SendErrorResponse(w, http.StatusUnauthorized, "Invalid ingest key", "invalid-key")
		return
	}
	if !allowedOrigin(w, r, project) {
		return
	}

	// Cap the body before reading it: a batch is bounded, and this is an
	// unauthenticated-by-JWT endpoint.
	r.Body = http.MaxBytesReader(w, r.Body, maxEventBatchBytes)

	batch, err := ValidateRequest[domain.IngestEventBatch](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}

	// Rate limit per DEVICE, not per project: every device in a fleet
	// heartbeats on its own schedule, so a project-wide bucket would throttle
	// the whole fleet at once.
	if !h.eventLimiter.allow(project.ID+":"+batch.DeviceID, eventsRateLimit()) {
		SendErrorResponse(w, http.StatusTooManyRequests, "Rate limit exceeded", "rate-limited")
		return
	}

	if err := h.telemetry.Ingest(project, batch, time.Now()); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to ingest telemetry", err.Error())
		return
	}
	SendResult(w, http.StatusAccepted, domain.APIResponse[any]{Success: true, Message: "Accepted"})
}

// echoCORS reflects the Origin so the widget (cross-origin) can read reporter
// responses. The report token is the real auth; CORS isn't the boundary here.
func echoCORS(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Vary", "Origin")
	}
}

// reportToken reads the per-report token from the Authorization header, falling
// back to ?token=.
//
// The query string was the only way for a long time, and it is where the widget
// still puts it — an <img> or a link can't set a header. But every request that
// carries it lands in the server's access log with the credential in the URL,
// so anything that *can* send a header should, and now can. The query stays
// because the widget ships separately and older copies are in other people's
// pages; dropping it would lock them out.
func reportToken(r *http.Request) string {
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimPrefix(a, "Bearer ")
	}
	if t := r.Header.Get("X-Report-Token"); t != "" {
		return t
	}
	return r.URL.Query().Get("token")
}

// ReporterView — GET /ingest/v1/reports/{id}?token= : the reporter's own view of
// their report (status + thread), authorized by the per-report token.
func (h *ingestHandler) ReporterView(w http.ResponseWriter, r *http.Request) {
	echoCORS(w, r)
	id := chi.URLParam(r, "id")
	token := reportToken(r)
	if !repository.VerifyReportToken(id, token) {
		SendErrorResponse(w, http.StatusUnauthorized, "Invalid token", "invalid-token")
		return
	}
	view, err := h.svc.ReporterView(id)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	// Renewed only when it's close to expiring, and only here: this is the call
	// a reporter makes every time they look at their report, so it's where a
	// fresh token reaches them without inventing a separate refresh endpoint.
	view.Token = repository.RenewReportTokenIfStale(id, token)
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReporterReportView]{Success: true, Data: view})
}

// UnreadCounts — POST /ingest/v1/reports/unread : batch unread-reply counts for
// the reporter's stored reports (one request instead of N). Each item carries
// its own per-report token; unverified items are skipped.
func (h *ingestHandler) UnreadCounts(w http.ResponseWriter, r *http.Request) {
	echoCORS(w, r)
	req, err := ValidateRequest[domain.UnreadRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	counts := make(map[string]int64, len(req.Items))
	for _, it := range req.Items {
		if repository.VerifyReportToken(it.ID, it.Token) {
			counts[it.ID] = h.svc.UnreadSince(it.ID, it.Since)
		}
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]int64]{Success: true, Data: counts})
}

// ReporterComment — POST /ingest/v1/reports/{id}/comments?token= : reporter adds
// a reply (text + optional images).
func (h *ingestHandler) ReporterComment(w http.ResponseWriter, r *http.Request) {
	echoCORS(w, r)
	id := chi.URLParam(r, "id")
	if !repository.VerifyReportToken(id, reportToken(r)) {
		SendErrorResponse(w, http.StatusUnauthorized, "Invalid token", "invalid-token")
		return
	}
	images, ok := readMultipartImages(w, r, "images")
	if !ok {
		return
	}
	body := r.FormValue("body")
	if body == "" && len(images) == 0 {
		SendErrorResponse(w, http.StatusBadRequest, "Empty comment", "empty")
		return
	}
	view, err := h.svc.ReporterComment(r.Context(), id, body, images)
	if err != nil {
		if errors.Is(err, service.ErrImagesUnavailable) {
			SendErrorResponse(w, http.StatusServiceUnavailable, "Image storage unavailable", err.Error())
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to comment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReporterReportView]{Success: true, Data: view})
}
