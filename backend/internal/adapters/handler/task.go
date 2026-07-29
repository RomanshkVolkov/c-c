package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type TaskHandler interface {
	Tree(w http.ResponseWriter, r *http.Request)
	CreateSpace(w http.ResponseWriter, r *http.Request)
	UpdateSpace(w http.ResponseWriter, r *http.Request)
	DeleteSpace(w http.ResponseWriter, r *http.Request)
	CreateFolder(w http.ResponseWriter, r *http.Request)
	UpdateFolder(w http.ResponseWriter, r *http.Request)
	DeleteFolder(w http.ResponseWriter, r *http.Request)
	CreateList(w http.ResponseWriter, r *http.Request)
	UpdateList(w http.ResponseWriter, r *http.Request)
	DeleteList(w http.ResponseWriter, r *http.Request)
	MoveList(w http.ResponseWriter, r *http.Request)
	Board(w http.ResponseWriter, r *http.Request)
	CreateStatus(w http.ResponseWriter, r *http.Request)
	UpdateStatus(w http.ResponseWriter, r *http.Request)
	MoveStatus(w http.ResponseWriter, r *http.Request)
	DeleteStatus(w http.ResponseWriter, r *http.Request)
	CreateTask(w http.ResponseWriter, r *http.Request)
	GetTask(w http.ResponseWriter, r *http.Request)
	UpdateTask(w http.ResponseWriter, r *http.Request)
	MoveTask(w http.ResponseWriter, r *http.Request)
	DeleteTask(w http.ResponseWriter, r *http.Request)
	AddComment(w http.ResponseWriter, r *http.Request)
	EditComment(w http.ResponseWriter, r *http.Request)
	DeleteComment(w http.ResponseWriter, r *http.Request)
	ListTags(w http.ResponseWriter, r *http.Request)
	CreateTag(w http.ResponseWriter, r *http.Request)
	UploadAttachment(w http.ResponseWriter, r *http.Request)
	DeleteAttachment(w http.ResponseWriter, r *http.Request)
}

type taskHandler struct {
	svc *service.TaskService
	// images proxies attachment uploads so the API key and bucket stay
	// server-side; nil/disabled simply turns attachments off.
	images *imageservice.Client
}

func NewTaskHandler(svc *service.TaskService, images *imageservice.Client) TaskHandler {
	return &taskHandler{svc: svc, images: images}
}

func mapTaskError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrSpaceNotFound),
		errors.Is(err, repository.ErrListNotFound),
		errors.Is(err, repository.ErrTaskNotFound),
		errors.Is(err, repository.ErrStatusNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", err.Error())
	case errors.Is(err, repository.ErrLastStatus):
		SendErrorResponse(w, http.StatusConflict, "A list needs at least one column", err.Error())
	case errors.Is(err, service.ErrNoStatuses):
		SendErrorResponse(w, http.StatusConflict, "List has no columns", err.Error())
	default:
		return false
	}
	return true
}

// authorizeOrg enforces membership in an org. Non-members get 404 rather than
// 403 so the API never confirms that an id exists in someone else's org.
func (h *taskHandler) authorizeOrg(w http.ResponseWriter, r *http.Request, orgID string, needWrite bool) (*domain.ClaimsJWT, bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return nil, false
	}
	role, member := user.RoleInOrg(orgID)
	if user.Superadmin {
		role, member = domain.OrgRoleAdmin, true
	}
	if !member {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return nil, false
	}
	if needWrite && !role.CanWrite() {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "viewer-read-only")
		return nil, false
	}
	return user, true
}

// resolveSpace walks a space id to its org and authorizes in one step; the same
// pattern repeats for folders, lists and tasks so every route is org-scoped.
func (h *taskHandler) resolveSpace(w http.ResponseWriter, r *http.Request, id string, needWrite bool) (*domain.TaskSpace, bool) {
	sp, err := h.svc.FindSpace(id)
	if err != nil {
		if !mapTaskError(w, err) {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to load space", err.Error())
		}
		return nil, false
	}
	if _, ok := h.authorizeOrg(w, r, sp.OrgID, needWrite); !ok {
		return nil, false
	}
	return sp, true
}

func (h *taskHandler) resolveList(w http.ResponseWriter, r *http.Request, id string, needWrite bool) (*domain.TaskList, *domain.TaskSpace, bool) {
	l, err := h.svc.FindList(id)
	if err != nil {
		if !mapTaskError(w, err) {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to load list", err.Error())
		}
		return nil, nil, false
	}
	sp, ok := h.resolveSpace(w, r, l.SpaceID, needWrite)
	if !ok {
		return nil, nil, false
	}
	return l, sp, true
}

func (h *taskHandler) resolveTask(w http.ResponseWriter, r *http.Request, id string, needWrite bool) (*domain.Task, bool) {
	t, err := h.svc.FindTask(id)
	if err != nil {
		if !mapTaskError(w, err) {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to load task", err.Error())
		}
		return nil, false
	}
	if _, ok := h.authorizeOrg(w, r, t.OrgID, needWrite); !ok {
		return nil, false
	}
	return t, true
}

// ─── Tree / spaces ────────────────────────────────────────────────────────────

func (h *taskHandler) Tree(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	tree, err := h.svc.Tree(user.OrgIDs(), user.Superadmin)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load spaces", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.SpaceTree]{Success: true, Data: tree})
}

func (h *taskHandler) CreateSpace(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.CreateSpaceRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if _, ok := h.authorizeOrg(w, r, req.OrgID, true); !ok {
		return
	}
	sp, err := h.svc.CreateSpace(req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create space", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskSpace]{Success: true, Data: sp})
}

func (h *taskHandler) UpdateSpace(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.RenameRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.RenameSpace(sp.ID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update space", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Space updated"})
}

func (h *taskHandler) DeleteSpace(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	if err := h.svc.DeleteSpace(sp.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete space", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Space deleted"})
}

// ─── Folders ──────────────────────────────────────────────────────────────────

func (h *taskHandler) CreateFolder(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateFolderRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	f, err := h.svc.CreateFolder(sp.ID, req.Name)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create folder", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskFolder]{Success: true, Data: f})
}

// resolveFolder authorizes through the folder's space.
func (h *taskHandler) resolveFolder(w http.ResponseWriter, r *http.Request, needWrite bool) (*domain.TaskFolder, bool) {
	f, err := h.svc.FindFolder(chi.URLParam(r, "id"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return nil, false
	}
	if _, ok := h.resolveSpace(w, r, f.SpaceID, needWrite); !ok {
		return nil, false
	}
	return f, true
}

func (h *taskHandler) UpdateFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := h.resolveFolder(w, r, true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateFolderRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.RenameFolder(f.ID, req.Name); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update folder", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Folder updated"})
}

func (h *taskHandler) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := h.resolveFolder(w, r, true)
	if !ok {
		return
	}
	if err := h.svc.DeleteFolder(f.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete folder", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Folder deleted"})
}

// ─── Lists ────────────────────────────────────────────────────────────────────

func (h *taskHandler) CreateList(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateListRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	l, err := h.svc.CreateList(sp.ID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create list", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskList]{Success: true, Data: l})
}

func (h *taskHandler) UpdateList(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateListRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.RenameList(l.ID, req.Name); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update list", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "List updated"})
}

func (h *taskHandler) DeleteList(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	if err := h.svc.DeleteList(l.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete list", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "List deleted"})
}

func (h *taskHandler) MoveList(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.MoveNodeRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.MoveList(l.ID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to move list", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "List moved"})
}

// ─── Board / statuses ─────────────────────────────────────────────────────────

func (h *taskHandler) Board(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	board, err := h.svc.Board(l.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load board", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.BoardResponse]{Success: true, Data: board})
}

func (h *taskHandler) CreateStatus(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.CreateStatusRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	st, err := h.svc.CreateStatus(l.ID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create column", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskStatus]{Success: true, Data: st})
}

// resolveStatus authorizes through the status' list.
func (h *taskHandler) resolveStatus(w http.ResponseWriter, r *http.Request) (*domain.TaskStatus, bool) {
	st, err := h.svc.FindStatus(chi.URLParam(r, "id"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return nil, false
	}
	if _, _, ok := h.resolveList(w, r, st.ListID, true); !ok {
		return nil, false
	}
	return st, true
}

func (h *taskHandler) UpdateStatus(w http.ResponseWriter, r *http.Request) {
	st, ok := h.resolveStatus(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateStatusRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.UpdateStatus(st.ID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update column", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Column updated"})
}

func (h *taskHandler) MoveStatus(w http.ResponseWriter, r *http.Request) {
	st, ok := h.resolveStatus(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.MoveNodeRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.MoveStatus(st.ID, req.AfterID, req.BeforeID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to move column", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Column moved"})
}

func (h *taskHandler) DeleteStatus(w http.ResponseWriter, r *http.Request) {
	st, ok := h.resolveStatus(w, r)
	if !ok {
		return
	}
	// Tasks must land somewhere: the caller names the column that absorbs them.
	moveTo := r.URL.Query().Get("moveTo")
	if err := h.svc.DeleteStatus(st.ID, moveTo); err != nil {
		if mapTaskError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusBadRequest, "Failed to delete column", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Column deleted"})
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

func (h *taskHandler) CreateTask(w http.ResponseWriter, r *http.Request) {
	l, sp, ok := h.resolveList(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateRequest[domain.CreateTaskRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	t, err := h.svc.CreateTask(l, sp.OrgID, user.UserID, req)
	if err != nil {
		if mapTaskError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create task", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.Task]{Success: true, Data: t})
}

func (h *taskHandler) GetTask(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	detail, err := h.svc.Detail(t.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load task", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.TaskDetail]{Success: true, Data: detail})
}

func (h *taskHandler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateTaskRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.UpdateTask(t.ID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update task", err.Error())
		return
	}
	detail, err := h.svc.Detail(t.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to reload task", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.TaskDetail]{Success: true, Data: detail})
}

func (h *taskHandler) MoveTask(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.MoveTaskRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// The destination column must belong to the same list — otherwise a move
	// could smuggle a task into another list (or org) entirely.
	st, err := h.svc.FindStatus(req.StatusID)
	if err != nil || st.ListID != t.ListID {
		SendErrorResponse(w, http.StatusBadRequest, "Column does not belong to this list", "bad-status")
		return
	}
	if err := h.svc.MoveTask(t.ID, req); err != nil {
		if mapTaskError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to move task", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Task moved"})
}

func (h *taskHandler) DeleteTask(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	if err := h.svc.DeleteTask(t.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete task", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Task deleted"})
}

// ─── Comments ─────────────────────────────────────────────────────────────────

func (h *taskHandler) AddComment(w http.ResponseWriter, r *http.Request) {
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	req, err := ValidateRequest[domain.TaskCommentRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if _, err := h.svc.AddComment(t.ID, user.UserID, req.Body); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to add comment", err.Error())
		return
	}
	detail, err := h.svc.Detail(t.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to reload task", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskDetail]{Success: true, Data: detail})
}

// commentScope loads a comment, authorizes its task, and enforces authorship —
// editing someone else's words isn't a permission an org role should grant.
func (h *taskHandler) commentScope(w http.ResponseWriter, r *http.Request) (*domain.TaskComment, bool) {
	c, err := h.svc.FindComment(chi.URLParam(r, "commentId"))
	if err != nil {
		SendErrorResponse(w, http.StatusNotFound, "Comment not found", "not-found")
		return nil, false
	}
	if _, ok := h.resolveTask(w, r, c.TaskID, true); !ok {
		return nil, false
	}
	user, _ := currentUser(r)
	if c.AuthorUserID != user.UserID && !user.Superadmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-the-author")
		return nil, false
	}
	return c, true
}

func (h *taskHandler) EditComment(w http.ResponseWriter, r *http.Request) {
	c, ok := h.commentScope(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.TaskCommentRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.EditComment(c.ID, req.Body); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to edit comment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Comment updated"})
}

func (h *taskHandler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	c, ok := h.commentScope(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteComment(c.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete comment", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Comment deleted"})
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

func (h *taskHandler) ListTags(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	tags, err := h.svc.ListTags(user.OrgIDs(), user.Superadmin)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list tags", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.TaskTag]{Success: true, Data: tags})
}

func (h *taskHandler) CreateTag(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.CreateTagRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if _, ok := h.authorizeOrg(w, r, req.OrgID, true); !ok {
		return
	}
	tag, err := h.svc.CreateTag(req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create tag", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskTag]{Success: true, Data: tag})
}
