package handler

import (
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
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

	att := &domain.TaskAttachment{
		TaskID:      t.ID,
		URL:         res.URL,
		FileName:    header.Filename,
		ContentType: res.ContentType,
		Bytes:       res.Bytes,
		UploadedBy:  user.UserID,
	}
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
