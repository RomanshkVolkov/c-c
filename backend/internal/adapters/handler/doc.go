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
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type DocHandler interface {
	Get(w http.ResponseWriter, r *http.Request)
	Save(w http.ResponseWriter, r *http.Request)
	SaveTab(w http.ResponseWriter, r *http.Request)
	Index(w http.ResponseWriter, r *http.Request)
	Patch(w http.ResponseWriter, r *http.Request)
	Versions(w http.ResponseWriter, r *http.Request)
	AddDecision(w http.ResponseWriter, r *http.Request)
	AppendTab(w http.ResponseWriter, r *http.Request)
	Restore(w http.ResponseWriter, r *http.Request)
	UploadAttachment(w http.ResponseWriter, r *http.Request)
	DeleteAttachment(w http.ResponseWriter, r *http.Request)
	RawAttachment(w http.ResponseWriter, r *http.Request)
}

type docHandler struct {
	svc    *service.DocService
	images *imageservice.Client
	store  *mediastore.Store
}

func NewDocHandler(svc *service.DocService, images *imageservice.Client, store *mediastore.Store) DocHandler {
	return &docHandler{svc: svc, images: images, store: store}
}

// resolveOwner validates the {kind}/{id} pair in the URL and checks the caller
// belongs to the owning org. Outsiders get 404, never 403 — the same anti-IDOR
// rule the task endpoints follow.
func (h *docHandler) resolveOwner(w http.ResponseWriter, r *http.Request) (domain.DocOwnerKind, string, string, bool) {
	kind := chi.URLParam(r, "kind")
	id := chi.URLParam(r, "ownerId")
	if !domain.ValidDocOwnerKind(kind) {
		SendErrorResponse(w, http.StatusBadRequest, "Unknown document owner", "bad-kind")
		return "", "", "", false
	}
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return "", "", "", false
	}
	orgID, err := h.svc.OwnerOrg(domain.DocOwnerKind(kind), id)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return "", "", "", false
	}
	if _, member := user.RoleInOrg(orgID); !member && !user.Superadmin {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return "", "", "", false
	}
	return domain.DocOwnerKind(kind), id, orgID, true
}

// resolveDoc is the same check for routes addressed by document id.
func (h *docHandler) resolveDoc(w http.ResponseWriter, r *http.Request) (*domain.Doc, bool) {
	d, err := h.svc.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return nil, false
	}
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, false
	}
	if _, member := user.RoleInOrg(d.OrgID); !member && !user.Superadmin {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return nil, false
	}
	return d, true
}

type docResponse struct {
	Doc *domain.Doc `json:"doc"`
	// Siempre las cuatro, también las vacías: la pantalla las pinta todas y una
	// que faltara la obligaría a inventarla.
	Tabs []domain.DocTab `json:"tabs"`
	// El registro va con el documento y no en su propia petición: es una de las
	// cuatro pestañas, y quien abre el documento va a verla igual que las otras.
	Decisions   []domain.Decision      `json:"decisions"`
	Attachments []domain.DocAttachment `json:"attachments"`
}

// nuevaRespuesta: listas vacías y no `null`, para que el cliente no las invente.
func nuevaRespuesta(d *domain.Doc) docResponse {
	return docResponse{
		Doc: d, Tabs: []domain.DocTab{},
		Decisions: []domain.Decision{}, Attachments: []domain.DocAttachment{},
	}
}

// completa rellena el documento entero. Un fallo al leer una parte no tumba la
// respuesta: se devuelve lo que sí se pudo leer.
func (h *docHandler) completa(doc *domain.Doc) docResponse {
	out := nuevaRespuesta(doc)
	if doc == nil {
		return out
	}
	if tabs, err := h.svc.Tabs(doc.ID); err == nil {
		out.Tabs = tabs
	}
	if ds, err := h.svc.Decisions(doc.ID); err == nil {
		out.Decisions = ds
	}
	if atts, err := h.svc.Attachments(doc.ID); err == nil {
		out.Attachments = atts
	}
	return out
}

func (h *docHandler) Get(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	d, err := h.svc.Get(kind, id)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the document", err.Error())
		return
	}
	// A node without a document is normal: answer with an empty one so the client
	// renders the same editor instead of special-casing "not created yet".
	out := h.completa(d)
	SendResult(w, http.StatusOK, domain.APIResponse[docResponse]{Success: true, Data: out})
}

// SaveTab guarda una sola sección.
func (h *docHandler) SaveTab(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	key := chi.URLParam(r, "tab")
	if !domain.IsDocTabKey(key) {
		SendErrorResponse(w, http.StatusBadRequest, "Unknown section", "bad-doc-tab")
		return
	}
	req, err := ValidateRequest[domain.SaveDocRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	doc, err := h.svc.SaveTab(orgID, kind, id, domain.DocTabKey(key), req.Body, user.UserID, req.BaseHash)
	if errors.Is(err, service.ErrDocConflict) {
		// 409 con el documento entero dentro: quien llama necesita el cuerpo
		// actual y su hash para fundir, y hacerle pedirlo aparte es un viaje más
		// en el que puede volver a cambiar.
		d, _ := h.svc.Get(kind, id)
		SendResult(w, http.StatusConflict, domain.APIResponse[docResponse]{
			Success: false, Error: "doc-conflict", Data: h.completa(d),
		})
		return
	}
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save the document", err.Error())
		return
	}
	out := h.completa(doc)
	SendResult(w, http.StatusOK, domain.APIResponse[docResponse]{Success: true, Data: out})
}

// AppendTab añade al final de una sección, sin pisar a quien la esté editando.
func (h *docHandler) AppendTab(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	key := chi.URLParam(r, "tab")
	if !domain.IsDocTabKey(key) {
		SendErrorResponse(w, http.StatusBadRequest, "Unknown section", "bad-doc-tab")
		return
	}
	req, err := ValidateRequest[domain.SaveDocRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	doc, err := h.svc.AppendTab(orgID, kind, id, domain.DocTabKey(key), req.Body, user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save the document", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[docResponse]{Success: true, Data: h.completa(doc)})
}

// AddDecision apunta una decisión en el registro de un documento.
func (h *docHandler) AddDecision(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.DecisionRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	// `via` viene de la cabecera que pone el MCP, así que la entrada queda
	// marcada como transcrita por un agente. Ver `Decision.Via`.
	if _, err := h.svc.AddDecision(orgID, kind, id, user.UserID, "", domain.ViaFrom(r.Context()), req); err != nil {
		if errors.Is(err, service.ErrDecisionUnaddressed) {
			SendErrorResponse(w, http.StatusBadRequest, "A decision needs somewhere to come back to", "decision-no-origin")
			return
		}
		var noEsta *service.ErrNoSuchColleague
		if errors.As(err, &noEsta) {
			// El mensaje trae la lista de a quién sí se puede nombrar: sin ella,
			// quien llama se queda probando variantes del mismo nombre.
			SendErrorResponse(w, http.StatusBadRequest, noEsta.Error(), "no-such-colleague")
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record the decision", err.Error())
		return
	}
	d, _ := h.svc.Get(kind, id)
	SendResult(w, http.StatusCreated, domain.APIResponse[docResponse]{Success: true, Data: h.completa(d)})
}

// Versions lista el historial de una sección.
func (h *docHandler) Versions(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	key := r.URL.Query().Get("tab")
	if !domain.IsDocTabKey(key) {
		SendErrorResponse(w, http.StatusBadRequest, "Unknown section", "bad-doc-tab")
		return
	}
	d, err := h.svc.Get(kind, id)
	// Un nodo sin documento no es un error: todavía no se ha escrito nada, así
	// que el historial está vacío y ésa es la respuesta correcta.
	if err != nil || d == nil {
		SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DocVersion]{Success: true, Data: []domain.DocVersion{}})
		return
	}
	vs, err := h.svc.Versions(d.ID, domain.DocTabKey(key))
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the history", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DocVersion]{Success: true, Data: vs})
}

// Restore devuelve una sección a un estado anterior.
func (h *docHandler) Restore(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	d, err := h.svc.Get(kind, id)
	if err != nil || d == nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	user, _ := currentUser(r)
	doc, err := h.svc.Restore(orgID, kind, id, d.ID, chi.URLParam(r, "versionId"), user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "That version is not part of this document", "bad-doc-version")
		return
	}
	out := h.completa(doc)
	SendResult(w, http.StatusOK, domain.APIResponse[docResponse]{Success: true, Data: out})
}

// Patch cambia lo que rodea al documento: responsable, revisión y línea fijada.
//
// Aparte del guardado del texto a propósito. Marcar revisado es un gesto de un
// clic sobre algo que no se ha tocado, y meterlo en la misma llamada que el
// cuerpo obligaría a mandar el markdown entero para decir «sigue siendo verdad».
func (h *docHandler) Patch(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.PatchDocRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	// Firmar una revisión no es editar.
	//
	// El chip de frescura vale porque hay **una persona** detrás diciendo «lo he
	// mirado y sigue funcionando». Si lo pudiera firmar cualquiera que pase por
	// aquí —incluido un agente con el token de su dueño— el campo pasaría a decir
	// «alguien tocó esto», que ya lo dice la fecha de modificación.
	//
	// Superadmin mientras no haya rol de admin de organización, que es el dueño
	// natural de esta firma. Los demás campos del PATCH no cambian.
	if domain.DocPatchSignsAReview(req) && !user.Superadmin {
		SendErrorResponse(w, http.StatusForbidden,
			"Only a superadmin can mark a document reviewed", "reviewed-needs-superadmin")
		return
	}
	d, err := h.svc.Patch(orgID, kind, id, user.UserID, req)
	var noEsta *service.ErrNoSuchColleague
	if errors.As(err, &noEsta) {
		SendErrorResponse(w, http.StatusBadRequest, noEsta.Error(), "no-such-colleague")
		return
	}
	if errors.Is(err, service.ErrNotAColleague) {
		SendErrorResponse(w, http.StatusBadRequest, "That person is not in this organization", "not-a-colleague")
		return
	}
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save the document", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Doc]{Success: true, Data: d})
}

func (h *docHandler) Save(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.SaveDocRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	d, err := h.svc.Save(orgID, kind, id, req.Body, user.UserID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save the document", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Doc]{Success: true, Data: d})
}

// Index lists which nodes of an org carry a document, so the navigator can mark
// them without loading every body.
func (h *docHandler) Index(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	orgID := r.URL.Query().Get("orgId")
	if orgID == "" {
		SendErrorResponse(w, http.StatusBadRequest, "orgId is required", "no-org")
		return
	}
	if _, member := user.RoleInOrg(orgID); !member && !user.Superadmin {
		SendResult(w, http.StatusOK, domain.APIResponse[map[string]domain.DocMark]{Success: true, Data: map[string]domain.DocMark{}})
		return
	}
	have, err := h.svc.HasDoc(orgID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list documents", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]domain.DocMark]{Success: true, Data: have})
}

func (h *docHandler) UploadAttachment(w http.ResponseWriter, r *http.Request) {
	d, ok := h.resolveDoc(w, r)
	if !ok {
		return
	}
	if h.images == nil || !h.images.Enabled() {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Attachments unavailable", "image-service-not-configured")
		return
	}
	if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(attachmentReadWindow)); err != nil {
		lg.Warn("doc attachment upload: could not extend read deadline: " + err.Error())
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
	res, err := h.images.UploadFile(r.Context(), header.Filename, header.Header.Get("Content-Type"), data, "docs/"+d.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Upload rejected", err.Error())
		return
	}

	att := &domain.DocAttachment{
		DocID:       d.ID,
		Path:        res.Key,
		FileName:    header.Filename,
		ContentType: res.ContentType,
		Bytes:       res.Bytes,
		UploadedBy:  user.UserID,
	}
	// Mint the id first: the stored URL embeds it, and letting anything else
	// assign it later would point the URL at a row that doesn't exist.
	att.ID = uuid.NewString()
	att.URL = domain.DocAttachmentRef(d.ID, att.ID)
	if err := h.svc.AddAttachment(att); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record attachment", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.DocAttachment]{Success: true, Data: att})
}

func (h *docHandler) DeleteAttachment(w http.ResponseWriter, r *http.Request) {
	d, ok := h.resolveDoc(w, r)
	if !ok {
		return
	}
	att, err := h.svc.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.DocID != d.ID {
		SendErrorResponse(w, http.StatusNotFound, "Attachment not found", "not-found")
		return
	}
	if err := h.svc.DeleteAttachment(att.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete attachment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Attachment deleted"})
}

// RawAttachment streams the bytes. Lives outside the JWT group for the same
// reason the task one does: an <img> can't set an Authorization header, so the
// token is accepted from the query string too.
func (h *docHandler) RawAttachment(w http.ResponseWriter, r *http.Request) {
	att, err := h.svc.FindAttachment(chi.URLParam(r, "attachmentId"))
	if err != nil || att.DocID != chi.URLParam(r, "id") {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	d, err := h.svc.FindByID(att.DocID)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	if !attachmentViewer(r, d.OrgID) {
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
