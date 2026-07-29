package handler

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

const (
	// image-service caps /upload/file at 30 MB; mirror it so we reject early
	// instead of buffering a body that will be refused downstream.
	maxAttachmentBytes = 30 << 20
	// Uploading 30 MB over a slow uplink takes far longer than the server's
	// global 15s ReadTimeout, which would kill the request mid-body.
	attachmentReadWindow = 5 * time.Minute
)

// UploadAttachment — POST /api/v1/tasks/{id}/attachments (multipart, field
// "file"). The bytes are proxied to image-service so its API key and the bucket
// stay server-side; the task only stores the resulting URL.
//
// Optional form field `commentId` attaches the file to a comment instead of the
// task itself.
func (h *taskHandler) UploadAttachment(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	if h.images == nil || !h.images.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachments unavailable", "image-service-not-configured")
		return
	}

	// Give the upload a real window: the server-wide ReadTimeout is tuned for
	// small JSON calls and would abort a large body long before it lands.
	if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(attachmentReadWindow)); err != nil {
		lg.Warn("attachment upload: could not extend read deadline: " + err.Error())
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes)
	if err := r.ParseMultipartForm(maxAttachmentBytes); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "File too large or invalid", err.Error())
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Missing file", err.Error())
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxAttachmentBytes+1))
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Could not read file", err.Error())
		return
	}
	if int64(len(data)) > maxAttachmentBytes {
		SendErrorResponse(w, http.StatusRequestEntityTooLarge, "File exceeds 30 MB", "too-large")
		return
	}

	user, _ := currentUser(r)
	res, err := h.images.UploadFile(
		r.Context(), header.Filename, header.Header.Get("Content-Type"), data,
		"tasks/"+t.ID,
	)
	if err != nil {
		// image-service owns the allowlist; pass its reason through so the user
		// learns *which* types are accepted instead of a generic failure.
		SendErrorResponse(w, http.StatusBadRequest, "Upload rejected", err.Error())
		return
	}

	// The stored URL is our proxy, not image-service's bucket URL: the bucket
	// denies anonymous reads, so a bucket URL inside a markdown <img> silently
	// renders nothing. The id is minted here so the URL can name it.
	att := &domain.TaskAttachment{
		TaskID:      t.ID,
		Path:        res.Key,
		FileName:    header.Filename,
		ContentType: res.ContentType,
		Bytes:       res.Bytes,
		UploadedBy:  user.UserID,
	}
	att.ID = uuid.NewString()
	att.URL = domain.AttachmentRef(t.ID, att.ID)
	if cid := r.FormValue("commentId"); cid != "" {
		att.CommentID = &cid
	}
	if err := h.svc.AddAttachment(att); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record attachment", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskAttachment]{Success: true, Data: att})
}

// DeleteAttachment removes the record. The blob itself is left to image-service's
// own lifecycle — deleting it here would break any markdown still referencing it
// from an edit history.
func (h *taskHandler) DeleteAttachment(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	att, err := h.svc.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.TaskID != t.ID {
		SendErrorResponse(w, http.StatusNotFound, "Attachment not found", "not-found")
		return
	}
	if err := h.svc.DeleteAttachment(att.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete attachment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Attachment deleted"})
}

// RawAttachment streams the bytes from the private bucket.
//
// Lives outside the JWT-authenticated group because a webview's <img>/<a>
// cannot set an Authorization header — it accepts `?token=` too, exactly like
// the report image proxy. Non-members get 404, never 403 (anti-IDOR).
func (h *taskHandler) RawAttachment(w http.ResponseWriter, r *http.Request) {
	att, err := h.svc.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.TaskID != chi.URLParam(r, "id") {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}

	orgID, err := h.svc.OrgIDForTask(att.TaskID)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	if !attachmentViewer(r, orgID) {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}

	// Authorization comes first so a caller who shouldn't see this attachment
	// learns nothing about our storage configuration.
	if h.store == nil || !h.store.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachment storage unavailable", "store-disabled")
		return
	}

	// Rows written before the proxy existed hold the bucket URL instead of a
	// key; recover the key from it so old attachments keep working.
	key := att.Path
	if key == "" {
		key = keyFromBucketURL(att.URL)
	}
	if key == "" {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "no-key")
		return
	}

	obj, err := h.store.Get(r.Context(), key)
	if err != nil {
		SendErrorResponse(w, http.StatusBadGateway, "Failed to fetch attachment", err.Error())
		return
	}
	defer obj.Body.Close()

	ct := obj.ContentType
	if ct == "" {
		ct = att.ContentType
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, no-store")
	// inline: images render in place; a browser still offers to save others.
	w.Header().Set("Content-Disposition", "inline; filename=\""+strings.ReplaceAll(att.FileName, "\"", "")+"\"")
	if obj.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, obj.Body)
}

// attachmentViewer reports whether the request carries a valid access token
// (header or ?token=) whose bearer belongs to the attachment's org.
func attachmentViewer(r *http.Request, orgID string) bool {
	token := r.URL.Query().Get("token")
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
	if claims.Superadmin {
		return true
	}
	_, member := claims.RoleInOrg(orgID)
	return member
}

// keyFromBucketURL extracts the object key from an image-service bucket URL
// (https://<bucket>.s3.<region>.amazonaws.com/<key>).
func keyFromBucketURL(raw string) string {
	i := strings.Index(raw, "amazonaws.com/")
	if i < 0 {
		return ""
	}
	return strings.TrimPrefix(raw[i+len("amazonaws.com/"):], "/")
}
