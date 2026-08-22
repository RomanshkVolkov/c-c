package handler

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// A space's channel of conversation.
//
// Authorization is the space's own — resolveSpace, which answers 404 rather than
// 403 to a non-member, so an id can't be used to discover that a space exists.
//
// Nothing here is on the personal-access-token allowlist, and that is the
// intended shape rather than an oversight: this is a private conversation
// between people, and an automated token reading or writing it is not a
// capability anybody asked for. If it is ever wanted it should be granted
// deliberately, with its own scope.

// ListChat answers a page of the channel, newest last.
func (h *taskHandler) ListChat(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	var before time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			before = t
		}
	}
	msgs, err := h.chat.List(sp.ID, before, atoiDefault(r.URL.Query().Get("limit"), 50))
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to read the channel", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ChatMessageResponse]{Success: true, Data: msgs})
}

// PostChat adds a line to the channel.
func (h *taskHandler) PostChat(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.ChatMessageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	m, err := h.chat.Post(sp.ID, sp.OrgID, user.UserID, req.Body)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to post", err.Error())
		return
	}
	// Posting is reading: nobody wants their own message counted as unread.
	if err := h.chat.MarkRead(sp.ID, user.UserID); err != nil {
		lg.Warn("chat: could not move the read mark: " + err.Error())
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ChatMessage]{Success: true, Data: m})
}

func (h *taskHandler) EditChat(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true); !ok {
		return
	}
	req, err := ValidateRequest[domain.ChatMessageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	err = h.chat.Edit(chi.URLParam(r, "messageId"), user.UserID, user.Superadmin, req.Body)
	if mapChatError(w, err) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Message updated"})
}

func (h *taskHandler) WithdrawChat(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true); !ok {
		return
	}
	user, _ := currentUser(r)
	err := h.chat.Withdraw(chi.URLParam(r, "messageId"), user.UserID, user.Superadmin)
	if mapChatError(w, err) {
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Message withdrawn"})
}

func (h *taskHandler) MarkChatRead(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	if err := h.chat.MarkRead(sp.ID, user.UserID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to mark read", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Marked read"})
}

// FollowChannel / UnfollowChannel: decir que este canal te importa, para que lo
// corriente que se hable aquí también te avise. `resolveSpace` es lo que impide
// seguir el canal de otra organización.
func (h *taskHandler) FollowChannel(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	if err := h.chat.Follow(sp.ID, user.UserID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to follow", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Following"})
}

func (h *taskHandler) UnfollowChannel(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	if err := h.chat.Unfollow(sp.ID, user.UserID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to unfollow", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Unfollowed"})
}

// FollowedChannels: todos de una vez, por la misma razón que los no leídos —
// la pantalla los necesita para pintar el botón y una consulta por canal sería
// una consulta por canal.
func (h *taskHandler) FollowedChannels(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	out, err := h.chat.Following(user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list", err.Error())
		return
	}
	if out == nil {
		out = []string{}
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]string]{Success: true, Data: out})
}

// ChatUnread answers every channel the caller has unread lines in, in one call —
// the navigator asks on every load and a request per space would be a request
// per space.
func (h *taskHandler) ChatUnread(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	out, err := h.chat.Unread(user.UserID, user.OrgIDs(), user.Superadmin)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to count", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.ChatUnread]{Success: true, Data: out})
}

// ─── Attachments ──────────────────────────────────────────────────────────────

// UploadChatAttachment proxies an image through image-service, exactly like a
// task attachment: the API key and the bucket never reach the desktop app.
func (h *taskHandler) UploadChatAttachment(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	if h.images == nil || !h.images.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachments unavailable", "image-service-not-configured")
		return
	}
	// The server-wide ReadTimeout is tuned for small JSON and would cut a large
	// body off before it lands.
	if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(attachmentReadWindow)); err != nil {
		lg.Warn("chat upload: could not extend read deadline: " + err.Error())
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
		r.Context(), header.Filename, header.Header.Get("Content-Type"), data, "chat/"+sp.ID,
	)
	if err != nil {
		// image-service owns the allowlist; pass its reason through so the person
		// learns which types are accepted.
		SendErrorResponse(w, http.StatusBadRequest, "Upload rejected", err.Error())
		return
	}

	// The id is minted here because the stored URL embeds it — the same reason
	// task attachments do it, after rows once pointed at ids that didn't exist.
	att := &domain.ChatAttachment{
		SpaceID:     sp.ID,
		Path:        res.Key,
		FileName:    header.Filename,
		ContentType: res.ContentType,
		Bytes:       res.Bytes,
		UploadedBy:  user.UserID,
	}
	att.ID = uuid.NewString()
	att.URL = domain.ChatAttachmentRef(sp.ID, att.ID)
	if err := h.chat.AddAttachment(att); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record attachment", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ChatAttachment]{Success: true, Data: att})
}

// RawChatAttachment streams the bytes back.
//
// Outside the JWT group because an <img> in a webview cannot set an
// Authorization header — same as task and doc attachments, and it accepts the
// same ?token= through attachmentViewer.
func (h *taskHandler) RawChatAttachment(w http.ResponseWriter, r *http.Request) {
	att, err := h.chat.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.SpaceID != chi.URLParam(r, "id") {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	sp, err := h.svc.FindSpace(att.SpaceID)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	// Authorization before anything else, so a caller who shouldn't see this
	// learns nothing about how it is stored.
	if !attachmentViewer(r, sp.OrgID) {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	if h.store == nil || !h.store.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachment storage unavailable", "store-disabled")
		return
	}
	obj, err := h.store.Get(r.Context(), att.Path)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
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
	// inline: images render in place; a browser still offers to save the rest.
	w.Header().Set("Content-Disposition", "inline; filename=\""+strings.ReplaceAll(att.FileName, "\"", "")+"\"")
	if obj.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, obj.Body)
}

func mapChatError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, service.ErrNotTheAuthor):
		SendErrorResponse(w, http.StatusForbidden,
			"Only the person who wrote this can change it.", "not-the-author")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed", err.Error())
	}
	return true
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return def
	}
	return n
}

// VoiceToken entrega la entrada a la sala de voz de un espacio.
//
// El guard es el mismo que el del chat de ese espacio —`resolveSpace`, que
// devuelve 404 a quien no pertenece a la organización— porque hablar y escribir
// en un canal son el mismo permiso. La sala no se acepta del cliente: se deriva
// del espacio que este handler ya resolvió y autorizó.
func (h *taskHandler) VoiceToken(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	if !h.voice.Configured() {
		// 501 y no 500: no está roto, es que esta instalación no tiene voz. La
		// pantalla puede decirlo con esas palabras.
		SendErrorResponse(w, http.StatusNotImplemented,
			"Voice is not configured on this server", "voice-unconfigured")
		return
	}
	user, _ := currentUser(r)
	token, err := h.voice.Token(sp.ID, user.UserID, user.Username)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to mint a voice token", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.VoiceTokenResponse]{
		Success: true,
		Data: &domain.VoiceTokenResponse{
			URL: h.voice.URL(), Token: token, Room: service.RoomFor(sp.ID),
		},
	})
}

// VoicePresence dice quién está en cada canal de voz, sin tener que entrar.
//
// Es lo que rompe el círculo de un canal de voz vacío: si no ves que hay
// alguien dentro no entras, y si nadie entra nunca hay nadie a quien ver. Va en
// una sola llamada para todos los espacios porque la lista de canales los pinta
// todos a la vez — una petición por canal sería una petición por canal.
//
// Los espacios salen del árbol que el propio caller puede ver, así que la
// pertenencia decide aquí igual que en todo lo demás: no se puede preguntar por
// la ocupación de una sala de otra organización porque su id nunca entra en la
// consulta.
func (h *taskHandler) VoicePresence(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "unauthorized")
		return
	}
	if !h.voice.Configured() {
		// Vacío y 200, no un error: una instalación sin voz no tiene a nadie
		// dentro de ninguna sala, y eso es una respuesta correcta.
		SendResult(w, http.StatusOK, domain.APIResponse[*service.Ocupacion]{
			Success: true, Data: &service.Ocupacion{},
		})
		return
	}

	arbol, err := h.svc.Tree(user.OrgIDs(), user.Superadmin, r.URL.Query().Get("orgId"))
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load spaces", err.Error())
		return
	}
	ids := make([]string, 0, len(arbol))
	for _, sp := range arbol {
		ids = append(ids, sp.ID)
	}

	dentro, err := h.voice.Ocupacion(r.Context(), ids)
	if err != nil {
		SendErrorResponse(w, http.StatusBadGateway, "Failed to ask the voice server", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*service.Ocupacion]{Success: true, Data: &dentro})
}
