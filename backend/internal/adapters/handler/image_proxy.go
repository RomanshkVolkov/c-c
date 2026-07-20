package handler

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ImageProxyHandler interface {
	Serve(w http.ResponseWriter, r *http.Request)
}

type imageProxyHandler struct {
	reports *repository.ReportRepository
	store   *mediastore.Store
}

func NewImageProxyHandler(reports *repository.ReportRepository, store *mediastore.Store) ImageProxyHandler {
	return &imageProxyHandler{reports: reports, store: store}
}

// Serve streams a report screenshot from the private bucket. It authorizes by
// EITHER a valid short-lived signature (?exp=&sig=, for the webview's <img>) OR
// a JWT (Authorization header / ?token=) with membership in the report's org.
// Non-members / bad signatures get 404 (anti-IDOR — never confirm existence).
func (h *imageProxyHandler) Serve(w http.ResponseWriter, r *http.Request) {
	reportID := chi.URLParam(r, "id")
	imageID := chi.URLParam(r, "imageId")

	if !h.authorized(r, reportID, imageID) {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}

	img, err := h.reports.FindImage(reportID, imageID)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}

	if !h.store.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Image storage unavailable", "store-disabled")
		return
	}
	obj, err := h.store.Get(r.Context(), img.Path)
	if err != nil {
		SendErrorResponse(w, http.StatusBadGateway, "Failed to fetch image", err.Error())
		return
	}
	defer obj.Body.Close()

	ct := obj.ContentType
	if ct == "" {
		ct = "image/webp" // image-service transcodes to webp
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, no-store")
	if obj.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, obj.Body)
}

func (h *imageProxyHandler) authorized(r *http.Request, reportID, imageID string) bool {
	// Mode 1 — signed URL.
	q := r.URL.Query()
	if sig := q.Get("sig"); sig != "" {
		exp, err := strconv.ParseInt(q.Get("exp"), 10, 64)
		if err == nil && repository.VerifyImageSig(reportID, imageID, exp, sig) {
			return true
		}
	}

	// Mode 2 — JWT (header or ?token=), then membership in the report's org.
	token := q.Get("token")
	if token == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimPrefix(h, "Bearer ")
		}
	}
	if token == "" {
		return false
	}
	claims, err := repository.ValidateAccessToken(token)
	if err != nil {
		return false
	}
	orgID, err := h.reports.OrgIDForReport(reportID)
	if err != nil {
		return false
	}
	_, member := claims.RoleInOrg(orgID)
	return member
}
