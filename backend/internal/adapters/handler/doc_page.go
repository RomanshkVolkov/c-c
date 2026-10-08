package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Las páginas de un documento. Todas pasan por `resolveOwner` —miembro de la
// organización del nodo, 404 a los demás— y el servicio comprueba además que la
// página es **del documento de ese nodo**: un id de página de otra organización
// puesto bajo una URL propia no abre nada.

// pageError traduce lo que puede salir mal con una página.
func pageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repository.ErrDocPageNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
	case errors.Is(err, repository.ErrDocPageParent):
		SendErrorResponse(w, http.StatusBadRequest, "That parent page is not in this document", "bad-parent-page")
	case errors.Is(err, repository.ErrDocPageCycle):
		SendErrorResponse(w, http.StatusConflict, "A page cannot hang from its own subpages", "page-cycle")
	case errors.Is(err, service.ErrDocBodyTooLong):
		SendErrorResponse(w, http.StatusRequestEntityTooLarge, "This text is too long for one page", "body-too-large")
	default:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to handle the page", err.Error())
	}
}

func (h *docHandler) PageTree(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	tree, err := h.svc.PageTree(kind, id, r.URL.Query().Get("trashed") == "1")
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DocPageTreeItem]{Success: true, Data: tree})
}

func (h *docHandler) CreatePage(w http.ResponseWriter, r *http.Request) {
	kind, id, orgID, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateDocPageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	p, err := h.svc.CreatePage(orgID, kind, id, req, user.UserID)
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.DocPage]{Success: true, Data: p})
}

func (h *docHandler) GetPage(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	v, err := h.svc.GetPage(kind, id, chi.URLParam(r, "pageId"))
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.DocPageView]{Success: true, Data: v})
}

// SavePage: 409 con la página actual dentro, como las pestañas. Quien llama
// necesita el cuerpo y el hash vigentes para fundir, y pedirlos aparte es un
// viaje más en el que puede volver a cambiar.
func (h *docHandler) SavePage(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.SaveDocPageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	pageID := chi.URLParam(r, "pageId")
	p, err := h.svc.SavePage(kind, id, pageID, req, user.UserID)
	if errors.Is(err, service.ErrDocPageConflict) {
		v, _ := h.svc.GetPage(kind, id, pageID)
		var actual *domain.DocPage
		if v != nil {
			actual = v.Page
		}
		SendResult(w, http.StatusConflict, domain.APIResponse[*domain.DocPage]{
			Success: false, Error: "doc-page-conflict", Data: actual,
		})
		return
	}
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.DocPage]{Success: true, Data: p})
}

func (h *docHandler) AppendPage(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.AppendDocPageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	p, err := h.svc.AppendPage(kind, id, chi.URLParam(r, "pageId"), req.Text, user.UserID)
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.DocPage]{Success: true, Data: p})
}

func (h *docHandler) MovePage(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.MoveDocPageRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	tree, err := h.svc.MovePage(kind, id, chi.URLParam(r, "pageId"), req)
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DocPageTreeItem]{Success: true, Data: tree})
}

func (h *docHandler) TrashPage(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	n, err := h.svc.TrashPage(kind, id, chi.URLParam(r, "pageId"))
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]int]{Success: true, Data: map[string]int{"pages": n}})
}

func (h *docHandler) RestorePage(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	if err := h.svc.RestorePage(kind, id, chi.URLParam(r, "pageId")); err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

func (h *docHandler) PageVersions(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	vs, err := h.svc.PageVersions(kind, id, chi.URLParam(r, "pageId"))
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.DocPageVersion]{Success: true, Data: vs})
}

func (h *docHandler) RestorePageVersion(w http.ResponseWriter, r *http.Request) {
	kind, id, _, ok := h.resolveOwner(w, r)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	p, err := h.svc.RestorePageVersion(kind, id, chi.URLParam(r, "pageId"), chi.URLParam(r, "versionId"), user.UserID)
	if err != nil {
		pageError(w, err)
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.DocPage]{Success: true, Data: p})
}
