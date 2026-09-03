package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type TaskHandler interface {
	Tree(w http.ResponseWriter, r *http.Request)
	ListOpen(w http.ResponseWriter, r *http.Request)
	CreateSpace(w http.ResponseWriter, r *http.Request)
	EnsureGeneralSpace(w http.ResponseWriter, r *http.Request)
	UpdateSpace(w http.ResponseWriter, r *http.Request)
	DeleteSpace(w http.ResponseWriter, r *http.Request)
	CreateFolder(w http.ResponseWriter, r *http.Request)
	UpdateFolder(w http.ResponseWriter, r *http.Request)
	DeleteFolder(w http.ResponseWriter, r *http.Request)
	CreateList(w http.ResponseWriter, r *http.Request)
	UpdateList(w http.ResponseWriter, r *http.Request)
	DeleteList(w http.ResponseWriter, r *http.Request)
	MoveList(w http.ResponseWriter, r *http.Request)
	MoveSpace(w http.ResponseWriter, r *http.Request)
	RawChatAttachment(w http.ResponseWriter, r *http.Request)
	UploadChatAttachment(w http.ResponseWriter, r *http.Request)
	ChatUnread(w http.ResponseWriter, r *http.Request)
	OpenDM(w http.ResponseWriter, r *http.Request)
	ListDMConversations(w http.ResponseWriter, r *http.Request)
	ListDMMessages(w http.ResponseWriter, r *http.Request)
	PostDM(w http.ResponseWriter, r *http.Request)
	EditDM(w http.ResponseWriter, r *http.Request)
	WithdrawDM(w http.ResponseWriter, r *http.Request)
	MarkDMRead(w http.ResponseWriter, r *http.Request)
	MarkChatRead(w http.ResponseWriter, r *http.Request)
	FollowChannel(w http.ResponseWriter, r *http.Request)
	Statuses(w http.ResponseWriter, r *http.Request)
	VoiceToken(w http.ResponseWriter, r *http.Request)
	VoiceRing(w http.ResponseWriter, r *http.Request)
	VoiceRingCancel(w http.ResponseWriter, r *http.Request)
	VoicePresence(w http.ResponseWriter, r *http.Request)
	UnfollowChannel(w http.ResponseWriter, r *http.Request)
	FollowedChannels(w http.ResponseWriter, r *http.Request)
	WithdrawChat(w http.ResponseWriter, r *http.Request)
	EditChat(w http.ResponseWriter, r *http.Request)
	PostChat(w http.ResponseWriter, r *http.Request)
	ListChat(w http.ResponseWriter, r *http.Request)
	RotateListChannelKey(w http.ResponseWriter, r *http.Request)
	UpdateListChannel(w http.ResponseWriter, r *http.Request)
	GetListChannel(w http.ResponseWriter, r *http.Request)
	RotateChannelKey(w http.ResponseWriter, r *http.Request)
	UpdateChannel(w http.ResponseWriter, r *http.Request)
	CreateChannel(w http.ResponseWriter, r *http.Request)
	GetChannel(w http.ResponseWriter, r *http.Request)
	MoveFolder(w http.ResponseWriter, r *http.Request)
	DuplicateFolder(w http.ResponseWriter, r *http.Request)
	SortSpace(w http.ResponseWriter, r *http.Request)
	Watch(w http.ResponseWriter, r *http.Request)
	Unwatch(w http.ResponseWriter, r *http.Request)
	SortFolder(w http.ResponseWriter, r *http.Request)
	MoveFolderToSpace(w http.ResponseWriter, r *http.Request)
	MoveListToSpace(w http.ResponseWriter, r *http.Request)
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
	RawAttachment(w http.ResponseWriter, r *http.Request)
	DeleteAttachment(w http.ResponseWriter, r *http.Request)
}

type taskHandler struct {
	svc *service.TaskService
	// channels configures how work gets in from outside. The settings live on the
	// space now rather than on a screen of their own, because the module that
	// screen belonged to is being folded into this one.
	channels *service.ReportProjectService
	repo     *repository.TaskRepository
	// chat is the space's channel of conversation — internal only, which is why
	// it has its own service rather than riding the item paths that reach a
	// tenant's webhook.
	chat *service.ChatService
	// dms is the private half of the same conversation surface.
	dms *service.DMService
	// docs es la documentación del proyecto, aquí sólo para `/decision`: lo que
	// se decide en una tarjeta se apunta en el documento de su lista, y esta
	// pantalla es donde se decide.
	docs *service.DocService
	// voice acuña las entradas a las salas del SFU. Puede no estar configurado:
	// una instalación sin voz es legítima y el handler lo dice con un 501.
	voice *service.VoiceService
	// images proxies attachment uploads so the API key and bucket stay
	// server-side; nil/disabled simply turns attachments off.
	images *imageservice.Client
	// store reads the bytes back out for RawAttachment. The bucket is private,
	// so serving attachments is our job, not the bucket's.
	store *mediastore.Store
}

func NewTaskHandler(
	svc *service.TaskService,
	channels *service.ReportProjectService,
	chat *service.ChatService,
	dms *service.DMService,
	repo *repository.TaskRepository,
	images *imageservice.Client,
	store *mediastore.Store,
	voice *service.VoiceService,
	docs *service.DocService,
) TaskHandler {
	return &taskHandler{svc: svc, channels: channels, chat: chat, dms: dms, repo: repo, images: images, store: store, voice: voice, docs: docs}
}

func mapTaskError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrSpaceNotFound),
		errors.Is(err, repository.ErrListNotFound),
		errors.Is(err, repository.ErrTaskNotFound),
		errors.Is(err, repository.ErrStatusNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Not found", err.Error())
	// 409 y no 403: quien pide tiene permiso de sobra —suele ser el admin— y la
	// petición está bien formada. Lo que se le niega es dejar la sala general en
	// un estado que no es el suyo.
	case errors.Is(err, service.ErrGeneralSpaceProtected):
		SendErrorResponse(w, http.StatusConflict,
			"The general room is the organization's channel, not a place for tasks: "+
				"it holds no lists or folders, and it cannot be deleted. Rename it if you like.",
			"general-space-protected")
	case errors.Is(err, service.ErrColumnsAreFixed):
		SendErrorResponse(w, http.StatusGone,
			"Board columns are fixed: To do, In progress, Done and Closed. "+
				"They are the states themselves now, so there is nothing to add or rename.",
			"columns-are-fixed")
	case errors.Is(err, repository.ErrChannelOtherOrg):
		SendErrorResponse(w, http.StatusForbidden,
			"That channel belongs to another organization.", "channel-other-org")
	case errors.Is(err, repository.ErrListHoldsChannelWork):
		SendErrorResponse(w, http.StatusConflict,
			"This list holds reports that belong to a client. Move them out before deleting it.",
			"list-holds-channel-work")
	case errors.Is(err, repository.ErrChannelNeedsInbox):
		SendErrorResponse(w, http.StatusConflict,
			"This list is where a client's reports arrive. Point that channel at another list "+
				"instead of unlinking it — a channel with nowhere to deliver loses everything it sends.",
			"channel-needs-inbox")
	case errors.Is(err, repository.ErrListInUseByChannel):
		SendErrorResponse(w, http.StatusConflict,
			"A report project delivers into this list, so deleting it would take that project's reports with it. "+
				"Point the project somewhere else first.", "list-in-use-by-channel")
	case errors.Is(err, repository.ErrLastStatus):
		SendErrorResponse(w, http.StatusConflict, "A list needs at least one column", err.Error())
	case errors.Is(err, service.ErrNoStatuses):
		SendErrorResponse(w, http.StatusConflict, "List has no columns", err.Error())
	case errors.Is(err, service.ErrParentOther):
		SendErrorResponse(w, http.StatusBadRequest, "Parent task is in another list", err.Error())
	// 409 y no 500: la petición es válida y quien la hace tiene permiso; lo que
	// pasa es que el estado actual no admite ese salto. Un 500 dice «se rompió
	// el servidor», y eso tiene consecuencias — un cliente que reintenta ante
	// 5xx, como el nuestro, reintenta tres veces contra una regla que nunca va a
	// ceder, y el registro acumula errores de servidor que no lo son.
	//
	// Mismo trato que ya recibe `ErrInvalidTransition` del lado de reportes, que
	// es literalmente la misma máquina de estados.
	case errors.Is(err, service.ErrBadTransition):
		SendErrorResponse(w, http.StatusConflict,
			"That move is not allowed from the current state. Open and Done are not "+
				"adjacent: a card passes through In progress.", "bad-transition")
	// 400 y no 409: aquí no hay conflicto con ningún estado, es que el id de
	// columna no nombra nada. Petición malformada.
	case errors.Is(err, service.ErrBadStatus):
		SendErrorResponse(w, http.StatusBadRequest, "Unknown column", err.Error())
	// Las dos de abajo ya contestaban 409, pero cada una desde su propio `if` en
	// un sitio distinto. Aquí sirven para cualquier ruta que use este ayudante, y
	// hay una sola tabla que mirar para saber qué contesta qué.
	case errors.Is(err, service.ErrFolderCycle):
		SendErrorResponse(w, http.StatusConflict, "Cannot move a folder inside itself", err.Error())
	case errors.Is(err, service.ErrDifferentOrganization):
		SendErrorResponse(w, http.StatusConflict,
			"That space belongs to another organization", err.Error())
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

// EnsureGeneralSpace: la sala de toda la organización, creada la primera vez
// que un admin la pide. Idempotente — pedirla dos veces devuelve la misma.
func (h *taskHandler) EnsureGeneralSpace(w http.ResponseWriter, r *http.Request) {
	req, err := ValidateRequest[domain.EnsureGeneralSpaceRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// Sólo admin. `authorizeOrg` con needWrite deja pasar a cualquier miembro que
	// escriba, y abrir el canal de toda la organización —y bautizarlo— es una
	// decisión de quien la administra.
	user, ok := h.authorizeOrg(w, r, req.OrgID, true)
	if !ok {
		return
	}
	if role, _ := user.RoleInOrg(req.OrgID); !user.Superadmin && role != domain.OrgRoleAdmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-an-admin")
		return
	}
	sp, err := h.svc.EnsureGeneralSpace(req.OrgID)
	if err != nil {
		if !mapTaskError(w, err) {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to open the general room", err.Error())
		}
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.TaskSpace]{Success: true, Data: sp})
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
	// ?orgId scopes the navigator to the org selected in the app. A caller can
	// only narrow to an org they already belong to; asking for someone else's
	// yields an empty tree rather than an error (nothing to reveal).
	orgID := r.URL.Query().Get("orgId")
	if orgID != "" && !user.Superadmin {
		if _, member := user.RoleInOrg(orgID); !member {
			SendResult(w, http.StatusOK, domain.APIResponse[[]domain.SpaceTree]{Success: true, Data: []domain.SpaceTree{}})
			return
		}
	}
	tree, err := h.svc.Tree(user.OrgIDs(), user.Superadmin, orgID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load spaces", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.SpaceTree]{Success: true, Data: tree})
}

// ListOpen answers the dashboard's pending list. Same scoping rules as Tree:
// ?orgId can only narrow to an org the caller already belongs to, and asking
// for someone else's yields an empty list rather than an error — a 403 here
// would confirm the org exists.
func (h *taskHandler) ListOpen(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	orgID := r.URL.Query().Get("orgId")
	if orgID != "" && !user.Superadmin {
		if _, member := user.RoleInOrg(orgID); !member {
			SendResult(w, http.StatusOK, domain.APIResponse[[]domain.OpenTask]{
				Success: true, Data: []domain.OpenTask{},
			})
			return
		}
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	tasks, err := h.svc.ListOpen(user.OrgIDs(), user.Superadmin, orgID, limit, openTaskFilter(r, user.UserID))
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load tasks", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.OpenTask]{Success: true, Data: tasks})
}

// openTaskFilter reads "my work" off the query string.
//
// `me` rather than a user id, and resolved here against the caller's own
// claims. Accepting an arbitrary id would turn this into "show me anybody's
// workload" — a different feature with a different answer about who may ask.
func openTaskFilter(r *http.Request, callerID string) domain.OpenTaskFilter {
	q := r.URL.Query()
	quien := func(k string) string {
		if q.Get(k) == "me" {
			return callerID
		}
		return ""
	}
	f := domain.OpenTaskFilter{
		AssigneeID:    quien("assignee"),
		CreatorID:     quien("creator"),
		WatcherID:     quien("watcher"),
		IncludeClosed: q.Get("status") == "all",
		Origin:        domain.OpenTaskOrigin(q.Get("origin")),
	}
	if v := q.Get("dueFrom"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.DueFrom = &t
		}
	}
	if v := q.Get("dueTo"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.DueTo = &t
		}
	}
	return f
}

// Watch and Unwatch put the caller on, or off, a task's followers.
func (h *taskHandler) Watch(w http.ResponseWriter, r *http.Request) {
	h.setWatch(w, r, true)
}

func (h *taskHandler) Unwatch(w http.ResponseWriter, r *http.Request) {
	h.setWatch(w, r, false)
}

func (h *taskHandler) setWatch(w http.ResponseWriter, r *http.Request, on bool) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	t, ok := h.resolveTask(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	var err error
	if on {
		err = h.svc.Watch(t.ID, user.UserID)
	} else {
		err = h.svc.Unwatch(t.ID, user.UserID)
	}
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update watchers", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Watchers updated"})
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
	if req.ProjectID != nil {
		if err := h.svc.BindSpace(sp.ID, *req.ProjectID); err != nil {
			mapTaskError(w, err)
			return
		}
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

// MoveSpace reorders a space. `?dir=up|down` shifts it one position (the server
// resolves the neighbours); an explicit afterId/beforeId body is also accepted.
func (h *taskHandler) MoveSpace(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	req, move := h.moveRequest(r, "task_spaces", "org_id", sp.OrgID, sp.ID)
	if !move {
		SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Already in place"})
		return
	}
	if err := h.svc.MoveSpace(sp.ID, req); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to move space", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Space moved"})
}

func (h *taskHandler) MoveFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := h.resolveFolder(w, r, true)
	if !ok {
		return
	}
	req, move := h.moveRequest(r, "task_folders", "space_id", f.SpaceID, f.ID)
	if !move {
		SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Already in place"})
		return
	}
	if err := h.svc.MoveFolder(f.ID, req); err != nil {
		// El ciclo de carpetas —«no puedes meterla dentro de sí misma»— lo
		// resuelve `mapTaskError`, igual que el resto.
		if mapTaskError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to move folder", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Folder moved"})
}

// moveRequest accepts either explicit neighbours in the body or a `dir=up|down`
// nudge, which is what a menu-driven reorder sends. move=false means there is
// nothing to do (already at that edge).
func (h *taskHandler) moveRequest(r *http.Request, table, scopeCol, scopeID, id string) (domain.MoveNodeRequest, bool) {
	if dir := r.URL.Query().Get("dir"); dir == "up" || dir == "down" {
		after, before, ok := h.svc.Neighbours(table, scopeCol, scopeID, id, dir == "up")
		return domain.MoveNodeRequest{AfterID: after, BeforeID: before}, ok
	}
	req, err := ValidateRequest[domain.MoveNodeRequest](r)
	if err != nil {
		return domain.MoveNodeRequest{}, false
	}
	return req, true
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
	f, err := h.svc.CreateFolder(sp.ID, req.Name, req.ParentFolderID)
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

// SortSpace and SortFolder order a container's children alphabetically.
func (h *taskHandler) SortSpace(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	if err := h.svc.SortSpace(sp.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to sort", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Sorted"})
}

func (h *taskHandler) SortFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := h.resolveFolder(w, r, true)
	if !ok {
		return
	}
	if err := h.svc.SortFolder(f.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to sort", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Sorted"})
}

// DuplicateFolder copies a folder's shape into the same space.
func (h *taskHandler) DuplicateFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := h.resolveFolder(w, r, true)
	if !ok {
		return
	}
	// The name is optional: without one the copy keeps the original's, which is
	// what a person renaming it straight afterwards would rather start from.
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	copia, err := h.svc.DuplicateFolder(f.ID, req.Name)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to duplicate folder", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.TaskFolder]{
		Success: true, Message: "Folder duplicated", Data: copia,
	})
}

// MoveFolderToSpace and MoveListToSpace both refuse to cross organizations.
func (h *taskHandler) MoveFolderToSpace(w http.ResponseWriter, r *http.Request) {
	f, ok := h.resolveFolder(w, r, true)
	if !ok {
		return
	}
	destino, ok := h.targetSpace(w, r)
	if !ok {
		return
	}
	if err := h.svc.MoveFolderToSpace(f.ID, destino); err != nil {
		h.sendMoveError(w, err, "Failed to move folder")
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Folder moved"})
}

func (h *taskHandler) MoveListToSpace(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), true)
	if !ok {
		return
	}
	destino, ok := h.targetSpace(w, r)
	if !ok {
		return
	}
	if err := h.svc.MoveListToSpace(l.ID, destino); err != nil {
		h.sendMoveError(w, err, "Failed to move list")
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "List moved"})
}

// targetSpace reads the destination and checks the caller may write to it.
// Checked on both ends: being allowed to move something out of a space says
// nothing about being allowed to put it into another.
func (h *taskHandler) targetSpace(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SpaceID == "" {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", "spaceId is required")
		return "", false
	}
	if _, ok := h.resolveSpace(w, r, req.SpaceID, true); !ok {
		return "", false
	}
	return req.SpaceID, true
}

func (h *taskHandler) sendMoveError(w http.ResponseWriter, err error, msg string) {
	if mapTaskError(w, err) {
		return
	}
	SendErrorResponse(w, http.StatusInternalServerError, msg, err.Error())
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
	if req.ProjectID != nil {
		if err := h.svc.BindList(l.ID, *req.ProjectID); err != nil {
			mapTaskError(w, err)
			return
		}
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

// Statuses son las columnas de una lista, sin las tarjetas.
//
// Existe porque el detalle de una tarea necesita saber a qué columnas puede
// moverla, y la tarea que estás mirando **casi nunca es de la lista que tienes
// abierta**: se llega a ella desde «mi trabajo», desde una notificación o desde
// un enlace. Pedir el tablero entero para leerle las columnas sería traerse
// todas las tarjetas de esa lista para tirarlas.
//
// La app lo llamaba desde antes de que existiera, y como el `POST` sí estaba,
// chi contestaba 405 en vez de 404. El menú de estado se abría vacío y no había
// forma de mover una tarjeta desde el detalle — ver App #24.
func (h *taskHandler) Statuses(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), false)
	if !ok {
		return
	}
	cols, err := h.svc.Statuses(l.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load columns", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.TaskStatus]{Success: true, Data: cols})
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
		if mapTaskError(w, err) {
			return
		}
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
		if mapTaskError(w, err) {
			return
		}
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
		if mapTaskError(w, err) {
			return
		}
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
	t, err := h.svc.CreateTask(r.Context(), l, sp.OrgID, user.UserID, req)
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
	editor, _ := currentUser(r)
	if err := h.svc.UpdateTask(r.Context(), t.ID, editor.UserID, req); err != nil {
		// Faltaba, y era la única escritura de tareas sin mapeo: hasta «esa
		// tarea no existe» o «ese padre es de otra lista» salían como 500.
		if mapTaskError(w, err) {
			return
		}
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
	mover, _ := currentUser(r)
	if err := h.svc.MoveTask(r.Context(), t.ID, mover.UserID, req); err != nil {
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
	// El origen se pone aquí y no se acepta del cliente: una decisión que dice
	// venir de otra tarea sería un enlace de vuelta que miente, y la procedencia
	// es lo único que hace que este registro valga algo.
	if req.Decision != nil && !domain.DecisionIsAddressed(domain.DecisionRequest{
		Title: req.Decision.Title, Origin: string(domain.DecisionFromTask), OriginTaskID: t.ID,
	}) {
		SendErrorResponse(w, http.StatusBadRequest, "A decision needs somewhere to come back to", "decision-no-origin")
		return
	}
	c, err := h.svc.AddComment(r.Context(), t.ID, user.UserID, req.Body, req.Visibility)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to add comment", err.Error())
		return
	}
	// La entrada va atada al comentario: reintentar no deja dos en un registro
	// del que no se puede borrar nada. Ver `AddDecision` en el repositorio.
	if req.Decision != nil && h.docs != nil {
		if _, err := h.docs.DecisionFromTask(
			t.OrgID, t.ListID, t.ID, user.UserID, c.ID, *req.Decision,
		); err != nil {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to record the decision", err.Error())
			return
		}
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
	if _, ok := h.resolveTask(w, r, c.ItemID, true); !ok {
		return nil, false
	}
	user, _ := currentUser(r)
	// A nil author is not a match for anybody. Editing someone else's words isn't
	// a permission an org role should grant, and an unattributed comment has no
	// owner to be — so it can only be touched by a superadmin.
	mine := c.AuthorUserID != nil && *c.AuthorUserID == user.UserID
	if !mine && !user.Superadmin {
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
	tags, err := h.svc.ListTags(user.OrgIDs(), user.Superadmin, r.URL.Query().Get("orgId"))
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

// ─── The channel into a space ─────────────────────────────────────────────────
//
// How work from outside gets in, configured where the work lives.
//
// None of these settings are new — a credential, allowed origins, rate limits, a
// webhook. They lived on a screen of their own, called "report projects",
// belonging to a module that is being folded into this one. Leaving them there
// would mean a space you can see belongs to a client, whose configuration is
// somewhere you have to remember exists.
//
// The row underneath is unchanged, so every key already issued keeps working and
// nothing a tenant integrated against moves.

// channelOfList authorizes through the list and returns the channel it reaches —
// its own binding or the one it inherits.
//
// Wherever a channel can be bound it can be configured. A binding you can create
// and then cannot reach is half a feature, and the half that is missing is the
// one with the credential in it.
func (h *taskHandler) channelOfList(
	w http.ResponseWriter, r *http.Request, needWrite bool,
) (*domain.TaskList, *domain.ReportProject, bool) {
	l, _, ok := h.resolveList(w, r, chi.URLParam(r, "id"), needWrite)
	if !ok {
		return nil, nil, false
	}
	id, err := h.repo.EffectiveChannel(l.ID)
	if err != nil || id == "" {
		return l, nil, true
	}
	p, err := h.channels.Find(id)
	if err != nil {
		return l, nil, true
	}
	return l, p, true
}

func (h *taskHandler) GetListChannel(w http.ResponseWriter, r *http.Request) {
	_, p, ok := h.channelOfList(w, r, false)
	if !ok {
		return
	}
	var data *domain.ReportProjectResponse
	if p != nil {
		data = service.ProjectResponse(p)
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportProjectResponse]{Success: true, Data: data})
}

func (h *taskHandler) UpdateListChannel(w http.ResponseWriter, r *http.Request) {
	_, p, ok := h.channelOfList(w, r, true)
	if !ok {
		return
	}
	if p == nil {
		SendErrorResponse(w, http.StatusNotFound, "This list reaches no channel", "no-channel")
		return
	}
	req, err := ValidateRequest[domain.UpdateReportProjectRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.channels.Update(p.ID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update the channel", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportProjectResponse]{Success: true, Data: out})
}

func (h *taskHandler) RotateListChannelKey(w http.ResponseWriter, r *http.Request) {
	_, p, ok := h.channelOfList(w, r, true)
	if !ok {
		return
	}
	if p == nil {
		SendErrorResponse(w, http.StatusNotFound, "This list reaches no channel", "no-channel")
		return
	}
	key, err := h.channels.RotateKey(p.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to rotate the key", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]string]{
		Success: true, Data: map[string]string{"ingestKey": key},
		Message: "Anything still using the old key stops working now.",
	})
}

// channelOfSpace authorizes through the space and returns its channel, or nil.
func (h *taskHandler) channelOfSpace(
	w http.ResponseWriter, r *http.Request, needWrite bool,
) (*domain.TaskSpace, *domain.ReportProject, bool) {
	sp, ok := h.resolveSpace(w, r, chi.URLParam(r, "id"), needWrite)
	if !ok {
		return nil, nil, false
	}
	if sp.ProjectID == nil || *sp.ProjectID == "" {
		return sp, nil, true
	}
	p, err := h.channels.Find(*sp.ProjectID)
	if err != nil {
		// The binding points at a channel that is gone. "No channel" is the
		// truthful answer and leaves opening a new one as the obvious next step.
		return sp, nil, true
	}
	return sp, p, true
}

func (h *taskHandler) GetChannel(w http.ResponseWriter, r *http.Request) {
	_, p, ok := h.channelOfSpace(w, r, false)
	if !ok {
		return
	}
	var data *domain.ReportProjectResponse
	if p != nil {
		data = service.ProjectResponse(p)
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportProjectResponse]{Success: true, Data: data})
}

// CreateChannel opens a way in and returns the key exactly once.
func (h *taskHandler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	sp, existing, ok := h.channelOfSpace(w, r, true)
	if !ok {
		return
	}
	if existing != nil {
		SendErrorResponse(w, http.StatusConflict,
			"This space already has a channel. Rotate its key rather than opening a second one.",
			"channel-exists")
		return
	}
	req, err := ValidateRequest[domain.CreateReportProjectRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	// The space decides the organization and, unless told otherwise, the name:
	// two fields nobody should have to retype about the thing they are looking at.
	req.OrgID = sp.OrgID
	if req.Name == "" {
		req.Name = sp.Name
	}
	out, err := h.channels.Create(req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to open the channel", err.Error())
		return
	}
	if err := h.repo.BindSpaceToChannel(sp.ID, out.Project.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to bind the channel", err.Error())
		return
	}
	// Shown here and never again: only its HMAC is stored.
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.CreateReportProjectResult]{Success: true, Data: out})
}

func (h *taskHandler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	_, p, ok := h.channelOfSpace(w, r, true)
	if !ok {
		return
	}
	if p == nil {
		SendErrorResponse(w, http.StatusNotFound, "This space has no channel", "no-channel")
		return
	}
	req, err := ValidateRequest[domain.UpdateReportProjectRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	out, err := h.channels.Update(p.ID, req)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update the channel", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.ReportProjectResponse]{Success: true, Data: out})
}

func (h *taskHandler) RotateChannelKey(w http.ResponseWriter, r *http.Request) {
	_, p, ok := h.channelOfSpace(w, r, true)
	if !ok {
		return
	}
	if p == nil {
		SendErrorResponse(w, http.StatusNotFound, "This space has no channel", "no-channel")
		return
	}
	key, err := h.channels.RotateKey(p.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to rotate the key", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]string]{
		Success: true, Data: map[string]string{"ingestKey": key},
		Message: "Anything still using the old key stops working now.",
	})
}
