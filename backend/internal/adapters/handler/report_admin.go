package handler

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type ReportAdminHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Transitions(w http.ResponseWriter, r *http.Request)
	Taxonomy(w http.ResponseWriter, r *http.Request)
	Get(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	AddComment(w http.ResponseWriter, r *http.Request)
	EditComment(w http.ResponseWriter, r *http.Request)
	DeleteComment(w http.ResponseWriter, r *http.Request)
	AttachImages(w http.ResponseWriter, r *http.Request)
	DetachImage(w http.ResponseWriter, r *http.Request)
}

type reportAdminHandler struct {
	svc *service.ReportService
}

func NewReportAdminHandler(svc *service.ReportService) ReportAdminHandler {
	return &reportAdminHandler{svc: svc}
}

func mapReportError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrReportNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Report not found", err.Error())
	case errors.Is(err, repository.ErrCommentNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Comment not found", err.Error())
	case errors.Is(err, repository.ErrImageNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Image not found", err.Error())
	case errors.Is(err, service.ErrInvalidTransition):
		SendErrorResponse(w, http.StatusConflict, "Invalid status transition", err.Error())
	case errors.Is(err, service.ErrAssigneeNotMember):
		SendErrorResponse(w, http.StatusBadRequest, "Assignee is not a member of the organization", err.Error())
	case errors.Is(err, service.ErrCommentImmutable):
		SendErrorResponse(w, http.StatusForbidden, "System comments are immutable", err.Error())
	case errors.Is(err, service.ErrNotCommentAuthor):
		SendErrorResponse(w, http.StatusForbidden, "Only the author can modify this comment", err.Error())
	case errors.Is(err, service.ErrEmptyComment):
		SendErrorResponse(w, http.StatusBadRequest, "Comment needs a body or at least one image", err.Error())
	case errors.Is(err, service.ErrImagesUnavailable):
		SendErrorResponse(w, http.StatusServiceUnavailable, "Image storage unavailable", err.Error())
	default:
		return false
	}
	return true
}

// authorize resolves the report's org and enforces membership. Non-members get
// 404 (anti-IDOR: don't leak report existence across orgs); viewers attempting
// writes get 403.
func (h *reportAdminHandler) authorize(w http.ResponseWriter, r *http.Request, needWrite bool) (*domain.ClaimsJWT, string, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, "", false
	}
	reportID := chi.URLParam(r, "id")

	// Gate 1 of 2 for a project key. It authorizes by "this report is mine",
	// never by org membership, so it can't reach a sibling project the same
	// organization owns. Mismatch answers 404, like a non-member does, so the
	// key can't be used to probe which report ids exist.
	if user.IsProjectScoped() {
		projectID, err := h.svc.ProjectIDForReport(reportID)
		if err != nil || projectID != user.ProjectID {
			SendErrorResponse(w, http.StatusNotFound, "Report not found", "not-found")
			return nil, "", false
		}
		return user, reportID, true
	}

	orgID, err := h.svc.OrgIDForReport(reportID)
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Report not found", "not-found")
		return nil, "", false
	}
	role, member := user.RoleInOrg(orgID)
	if user.Superadmin { // platform admin acts on any org's reports
		role, member = domain.OrgRoleAdmin, true
	}
	if !member {
		SendErrorResponse(w, http.StatusNotFound, "Report not found", "not-found")
		return nil, "", false
	}
	if needWrite && !role.CanWrite() {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "viewer-read-only")
		return nil, "", false
	}
	return user, reportID, true
}

func (h *reportAdminHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}

	qs := r.URL.Query()
	q := domain.ReportListQuery{
		ProjectID:  qs.Get("projectId"),
		AssigneeID: qs.Get("assigneeUserId"),
		ReporterID: qs.Get("reporterId"),
		Limit:      50,
	}
	if s := qs.Get("status"); s != "" {
		status := domain.ReportStatus(s).Canonical()
		if !status.IsValid() {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid status filter", "invalid-status")
			return
		}
		q.Status = status
	}
	if c := qs.Get("category"); c != "" {
		cat := domain.ReportCategory(c)
		if !cat.IsValid() {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid category filter", "invalid-category")
			return
		}
		q.Category = cat
	}
	if p := qs.Get("priority"); p != "" {
		pri := domain.ReportPriority(p)
		if !pri.IsValid() {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid priority filter", "invalid-priority")
			return
		}
		q.Priority = pri
	}
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid limit", "invalid-limit")
			return
		}
		q.Limit = min(n, 200)
	}
	if v := qs.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			SendErrorResponse(w, http.StatusBadRequest, "Invalid offset", "invalid-offset")
			return
		}
		q.Offset = n
	}
	for param, dst := range map[string]**time.Time{"from": &q.From, "to": &q.To} {
		if v := qs.Get(param); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				SendErrorResponse(w, http.StatusBadRequest, "Invalid "+param+" date (RFC3339)", err.Error())
				return
			}
			*dst = &t
		}
	}

	// Gate 2 of 2. A project key sees its own project and nothing else.
	//
	// Asking for someone else's ?projectId= answers an empty list, not this
	// project's reports. Overwriting the filter instead would hand the caller
	// data it did not ask for under the id of a project it cannot see — safe,
	// but the kind of silent substitution an integrator debugs for an hour.
	// Empty is also what a non-member already gets, so it leaks nothing about
	// whether that project exists.
	orgIDs, superadmin := user.OrgIDs(), user.Superadmin
	if user.IsProjectScoped() {
		if q.ProjectID != "" && q.ProjectID != user.ProjectID {
			SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportListResult]{
				Success: true,
				Data:    &domain.ReportListResult{Items: []domain.ReportListItem{}, Limit: q.Limit, Offset: q.Offset},
			})
			return
		}
		q.ProjectID = user.ProjectID
		orgIDs, superadmin = []string{user.ProjectOrgID}, false
	}

	result, err := h.svc.List(orgIDs, q, superadmin)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list reports", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportListResult]{Success: true, Data: result})
}

// Transitions exposes the server-side state machine so the app never duplicates
// it (portento drift gotcha fixed at the source).
func (h *reportAdminHandler) Transitions(w http.ResponseWriter, r *http.Request) {
	SendResult(w, http.StatusOK, domain.APIResponse[map[domain.ReportStatus][]domain.ReportStatus]{
		Success: true,
		Data:    domain.ReportTransitions(),
	})
}

// Taxonomy exposes the closed sets a client may offer, so the console and the
// widget don't keep their own copy of the values and drift from the server —
// the same reasoning as Transitions above.
func (h *reportAdminHandler) Taxonomy(w http.ResponseWriter, r *http.Request) {
	SendResult(w, http.StatusOK, domain.APIResponse[domain.ReportTaxonomy]{
		Success: true,
		Data: domain.ReportTaxonomy{
			Categories: domain.ReportCategories(),
			Priorities: domain.ReportPriorities(),
		},
	})
}

func (h *reportAdminHandler) Get(w http.ResponseWriter, r *http.Request) {
	_, reportID, ok := h.authorize(w, r, false)
	if !ok {
		return
	}
	detail, err := h.svc.Detail(reportID)
	if err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load report", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportDetailResponse]{Success: true, Data: detail})
}

func (h *reportAdminHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, reportID, ok := h.authorize(w, r, true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateReportRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// Fold the alias here so the service, the transition check and the row all
	// see one vocabulary regardless of which one the client speaks.
	if req.Status != nil {
		canonical := req.Status.Canonical()
		req.Status = &canonical
	}
	detail, err := h.svc.Update(user.EventActor(), reportID, req)
	if err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update report", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportDetailResponse]{Success: true, Data: detail})
}

// AddComment accepts multipart (body + up to 5 inline images) so a comment and
// its screenshots land in one request. Body may be empty when images come.
func (h *reportAdminHandler) AddComment(w http.ResponseWriter, r *http.Request) {
	user, reportID, ok := h.authorize(w, r, true)
	if !ok {
		return
	}
	images, ok := readMultipartImages(w, r, "images")
	if !ok {
		return
	}
	body := r.FormValue("body")
	add := func() (*domain.ReportDetailResponse, error) {
		if user.IsProjectScoped() {
			return h.svc.AddProjectComment(r.Context(), user.ProjectName, reportID, body, images)
		}
		return h.svc.AddComment(r.Context(), user.UserID, reportID, body, images)
	}
	detail, err := add()
	if err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to add comment", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ReportDetailResponse]{Success: true, Data: detail})
}

func (h *reportAdminHandler) EditComment(w http.ResponseWriter, r *http.Request) {
	user, reportID, ok := h.authorize(w, r, true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateReportCommentRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	editErr := func() error {
		if user.IsProjectScoped() {
			return h.svc.EditProjectComment(user.ProjectName, reportID, chi.URLParam(r, "commentId"), req.Body)
		}
		return h.svc.EditComment(user.UserID, reportID, chi.URLParam(r, "commentId"), req.Body)
	}
	if err := editErr(); err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to edit comment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Comment updated"})
}

func (h *reportAdminHandler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	user, reportID, ok := h.authorize(w, r, true)
	if !ok {
		return
	}
	delErr := func() error {
		if user.IsProjectScoped() {
			return h.svc.DeleteProjectComment(user.ProjectName, reportID, chi.URLParam(r, "commentId"))
		}
		return h.svc.DeleteComment(user.UserID, reportID, chi.URLParam(r, "commentId"))
	}
	if err := delErr(); err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete comment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Comment deleted"})
}

func (h *reportAdminHandler) AttachImages(w http.ResponseWriter, r *http.Request) {
	user, reportID, ok := h.authorize(w, r, true)
	if !ok {
		return
	}
	images, ok := readMultipartImages(w, r, "images")
	if !ok {
		return
	}
	detail, err := h.svc.AttachImages(r.Context(), user.EventActor(), reportID, images)
	if err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to attach images", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.ReportDetailResponse]{Success: true, Data: detail})
}

func (h *reportAdminHandler) DetachImage(w http.ResponseWriter, r *http.Request) {
	_, reportID, ok := h.authorize(w, r, true)
	if !ok {
		return
	}
	if err := h.svc.DetachImage(reportID, chi.URLParam(r, "imageId")); err != nil {
		if mapReportError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to detach image", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Image detached"})
}
