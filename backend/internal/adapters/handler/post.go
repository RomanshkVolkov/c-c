package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// El muro de feedback y comunicados (ver domain/post.go). Quién ve qué lo
// decide el servicio (`canSee`); aquí sólo se traduce a HTTP. Lo que no puedes
// ver contesta 404, igual que lo que no existe.
type PostHandler struct {
	svc    *service.PostService
	images *imageservice.Client
	store  *mediastore.Store
}

func NewPostHandler(svc *service.PostService, images *imageservice.Client, store *mediastore.Store) *PostHandler {
	return &PostHandler{svc: svc, images: images, store: store}
}

func (h *PostHandler) List(w http.ResponseWriter, r *http.Request) {
	c, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	page, err := h.svc.List(c, r.URL.Query().Get("cursor"))
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PostPage]{Success: true, Data: page})
}

func (h *PostHandler) Get(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	out, err := h.svc.Get(c, chi.URLParam(r, "id"))
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PostDetailResponse]{Success: true, Data: out})
}

func (h *PostHandler) Create(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	req, err := ValidateRequest[domain.CreatePostRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.Create(c, domain.ViaFrom(r.Context()), req)
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.PostDetailResponse]{Success: true, Data: out})
}

func (h *PostHandler) Update(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	req, err := ValidateRequest[domain.UpdatePostRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.Update(c, chi.URLParam(r, "id"), req)
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PostDetailResponse]{Success: true, Data: out})
}

func (h *PostHandler) Publish(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	out, err := h.svc.Publish(c, chi.URLParam(r, "id"))
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PostDetailResponse]{Success: true, Data: out})
}

func (h *PostHandler) Pin(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	req, err := ValidateRequest[domain.PinPostRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.Pin(c, chi.URLParam(r, "id"), req.Pinned)
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.PostDetailResponse]{Success: true, Data: out})
}

func (h *PostHandler) ReactComment(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	req, err := ValidateRequest[domain.ReactionRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.ReactComment(c, chi.URLParam(r, "id"), chi.URLParam(r, "commentId"), req); err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func (h *PostHandler) Delete(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	if err := h.svc.Delete(c, chi.URLParam(r, "id")); err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func (h *PostHandler) Comment(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	req, err := ValidateRequest[domain.CreatePostCommentRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.svc.Comment(c, domain.ViaFrom(r.Context()), chi.URLParam(r, "id"), req)
	if err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.PostDetailResponse]{Success: true, Data: out})
}

func (h *PostHandler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	if err := h.svc.DeleteComment(c, chi.URLParam(r, "id"), chi.URLParam(r, "commentId")); err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func (h *PostHandler) React(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	req, err := ValidateRequest[domain.ReactionRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.React(c, chi.URLParam(r, "id"), req); err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func (h *PostHandler) Seen(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	if err := h.svc.MarkSeen(c); err != nil {
		postError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

// Upload: una imagen para una publicación o un comentario que se está
// escribiendo. Pasa por image-service, como las del chat.
func (h *PostHandler) Upload(w http.ResponseWriter, r *http.Request) {
	c, _ := currentUser(r)
	data, header, ok := readUploadWith(h.images, w, r)
	if !ok {
		return
	}
	res, err := h.images.UploadFile(r.Context(), header.Filename, header.Header.Get("Content-Type"), data, "posts/"+c.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Upload rejected", err.Error())
		return
	}
	att := &domain.PostAttachment{
		UploadedBy: c.UserID, Path: res.Key, FileName: header.Filename,
		ContentType: res.ContentType, Bytes: res.Bytes,
	}
	if err := h.svc.SaveAttachment(att); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record attachment", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.PostAttachment]{Success: true, Data: att})
}

// Raw sirve los bytes. Fuera del grupo con JWT porque un <img> no manda
// cabeceras: acepta la sesión o un `?token=` de medios, como las del chat. Lo
// que no puedes ver es un 404, antes de tocar el almacén.
func (h *PostHandler) Raw(w http.ResponseWriter, r *http.Request) {
	c, err := claimsFromHeaderOrTicket(r, repository.URLScopeMedia)
	if err != nil || c == nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	att, err := h.svc.Attachment(c, chi.URLParam(r, "attachmentId"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	streamStoredWith(h.store, w, r, att.Path, att.ContentType, att.FileName)
}

func postError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repository.ErrPostNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", "post-not-found")
	case errors.Is(err, service.ErrPostForbidden):
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "post-forbidden")
	case errors.Is(err, service.ErrPostBadCursor):
		SendErrorResponse(w, http.StatusBadRequest, "Bad cursor", "post-bad-cursor")
	case errors.Is(err, service.ErrBadReaction):
		SendErrorResponse(w, http.StatusBadRequest, "Bad reaction", "bad-reaction")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Post error", "post-failed")
	}
}
