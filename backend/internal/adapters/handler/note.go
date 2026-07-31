package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type NoteHandler interface {
	Tree(w http.ResponseWriter, r *http.Request)
	Get(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	Delete(w http.ResponseWriter, r *http.Request)
	MoveTree(w http.ResponseWriter, r *http.Request)
	Search(w http.ResponseWriter, r *http.Request)
	UploadAttachment(w http.ResponseWriter, r *http.Request)
	DeleteAttachment(w http.ResponseWriter, r *http.Request)
	RawAttachment(w http.ResponseWriter, r *http.Request)
}

type noteHandler struct {
	svc    *service.NoteService
	images *imageservice.Client
	store  *mediastore.Store
}

func NewNoteHandler(svc *service.NoteService, images *imageservice.Client, store *mediastore.Store) NoteHandler {
	return &noteHandler{svc: svc, images: images, store: store}
}

func mapNoteError(w http.ResponseWriter, err error) bool {
	switch {
	case err == repository.ErrNoteNotFound:
		// Anti-IDOR: a note that exists but belongs to someone else answers
		// exactly the same as one that doesn't exist at all.
		SendErrorResponse(w, http.StatusNotFound, "Note not found", "not-found")
	case err == service.ErrNoteCycle:
		SendErrorResponse(w, http.StatusBadRequest, "That move would create a cycle", "cycle")
	default:
		return false
	}
	return true
}

func (h *noteHandler) Tree(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	tree, err := h.svc.Tree(user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load notes", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.NoteTreeItem]{Success: true, Data: tree})
}

func (h *noteHandler) Get(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	n, err := h.svc.Get(chi.URLParam(r, "id"), user.UserID)
	if err != nil {
		if mapNoteError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the note", err.Error())
		return
	}
	atts, err := h.svc.Attachments(n.ID)
	if err != nil {
		atts = []domain.NoteAttachment{}
	}
	// Bundled with the note rather than a separate endpoint: opening a page is
	// exactly when "what links here" is useful, and it's one more read on an
	// already-loaded id, not a query a client would otherwise have to schedule.
	backlinks, err := h.svc.Backlinks(n.ID, user.UserID)
	if err != nil {
		backlinks = []domain.NoteSearchResult{}
	}
	SendResult(w, http.StatusOK, domain.APIResponse[noteDetail]{
		Success: true,
		Data:    noteDetail{Note: n, Attachments: atts, Backlinks: backlinks},
	})
}

type noteDetail struct {
	Note        *domain.Note              `json:"note"`
	Attachments []domain.NoteAttachment   `json:"attachments"`
	Backlinks   []domain.NoteSearchResult `json:"backlinks"`
}

func (h *noteHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.CreateNoteRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// A parent has to be one of the caller's own notes — otherwise a page could
	// be filed under someone else's private tree.
	if req.ParentID != nil {
		if _, err := h.svc.Get(*req.ParentID, user.UserID); err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "Parent note not found", "bad-parent")
			return
		}
	}
	n, err := h.svc.Create(user.UserID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create the note", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.Note]{Success: true, Data: n})
}

func (h *noteHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	req, err := ValidateRequest[domain.UpdateNoteRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	n, err := h.svc.Update(chi.URLParam(r, "id"), user.UserID, req)
	if err != nil {
		if mapNoteError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save the note", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Note]{Success: true, Data: n})
}

// Delete removes the note and every note below it. The count is returned so a
// client that skipped the confirm-first round trip (e.g. a script) still gets
// told what happened, rather than a bare "ok".
func (h *noteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	id := chi.URLParam(r, "id")
	ids, err := h.svc.Descendants(id, user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to resolve subpages", err.Error())
		return
	}
	if len(ids) == 0 {
		SendErrorResponse(w, http.StatusNotFound, "Note not found", "not-found")
		return
	}
	if err := h.svc.Delete(id, user.UserID); err != nil {
		if mapNoteError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete the note", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]int]{Success: true, Data: map[string]int{"deleted": len(ids)}})
}

func (h *noteHandler) MoveTree(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	// Not run through ValidateRequest: that helper calls validator.Struct, which
	// only accepts a struct, not a bare slice body.
	var moves []domain.NoteTreeMove
	if err := json.NewDecoder(r.Body).Decode(&moves); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.MoveTree(moves, user.UserID); err != nil {
		if mapNoteError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to move notes", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Tree updated"})
}

func (h *noteHandler) Search(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	results, err := h.svc.Search(user.UserID, q, limit)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Search failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.NoteSearchResult]{Success: true, Data: results})
}

func (h *noteHandler) UploadAttachment(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	n, err := h.svc.Get(chi.URLParam(r, "id"), user.UserID)
	if err != nil {
		mapNoteError(w, err)
		return
	}
	if h.images == nil || !h.images.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachments unavailable", "image-service-not-configured")
		return
	}
	if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(attachmentReadWindow)); err != nil {
		lg.Warn("note attachment upload: could not extend read deadline: " + err.Error())
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

	res, err := h.images.UploadFile(r.Context(), header.Filename, header.Header.Get("Content-Type"), data, "notes/"+n.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Upload rejected", err.Error())
		return
	}

	att := &domain.NoteAttachment{
		NoteID:      n.ID,
		Path:        res.Key,
		FileName:    header.Filename,
		ContentType: res.ContentType,
		Bytes:       res.Bytes,
		UploadedBy:  user.UserID,
	}
	if err := h.svc.AddAttachment(att); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record attachment", err.Error())
		return
	}
	// The id only exists after Create (unlike docs/tasks, it isn't minted ahead
	// of the insert), so the ref is built after the row exists.
	att.URL = domain.NoteAttachmentRef(n.ID, att.ID)
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.NoteAttachment]{Success: true, Data: att})
}

func (h *noteHandler) DeleteAttachment(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	n, err := h.svc.Get(chi.URLParam(r, "id"), user.UserID)
	if err != nil {
		mapNoteError(w, err)
		return
	}
	att, err := h.svc.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.NoteID != n.ID {
		SendErrorResponse(w, http.StatusNotFound, "Attachment not found", "not-found")
		return
	}
	if err := h.svc.DeleteAttachment(att.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete attachment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Attachment deleted"})
}

// RawAttachment streams the bytes. Lives outside the JWT group — an <img> can't
// set an Authorization header — so the token is accepted from the query string
// too, same as the task/doc proxies.
//
// Deliberately does NOT let a superadmin through. Every other module in cac
// treats superadmin as "sees everything in every org"; notes have no org, and
// letting the platform owner read someone's private notes because they also
// happen to run the platform would make "private" a lie. This is the one place
// in the codebase where that rule is inverted, and it's inverted on purpose.
func (h *noteHandler) RawAttachment(w http.ResponseWriter, r *http.Request) {
	att, err := h.svc.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.NoteID != chi.URLParam(r, "id") {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	// Get() scopes by owner in the query itself, so this is both the ownership
	// check and the existence check: a wrong or missing token, or someone else's
	// note, all fail here identically.
	if _, err := h.svc.Get(att.NoteID, noteAttachmentOwner(r)); err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}

	if h.store == nil || !h.store.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachment storage unavailable", "store-disabled")
		return
	}
	obj, err := h.store.Get(r.Context(), att.Path)
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
	w.Header().Set("Content-Disposition", "inline; filename=\""+strings.ReplaceAll(att.FileName, "\"", "")+"\"")
	if obj.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, obj.Body)
}

// noteAttachmentOwner extracts the caller's user id from a token supplied by
// header or query string. Returns "" (never matches any note) if absent or
// invalid — the anti-IDOR 404 falls out of NoteService.Get finding nothing.
func noteAttachmentOwner(r *http.Request) string {
	token := r.URL.Query().Get("token")
	if token == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimPrefix(h, "Bearer ")
		}
	}
	if token == "" {
		return ""
	}
	claims, err := repository.ValidateAccessToken(token)
	if err != nil {
		return ""
	}
	return claims.UserID
}
