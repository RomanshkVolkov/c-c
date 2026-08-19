package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/rank"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrNoStatuses  = errors.New("list has no status columns")
	ErrParentOther = errors.New("parent task belongs to another list")
	// ErrBadStatus: the status id doesn't name a column on this board.
	ErrBadStatus = errors.New("unknown status")
	// ErrBadTransition: the move is one the shared state machine refuses.
	ErrBadTransition = errors.New("that move is not allowed from the current state")
)

type TaskService struct {
	repo *repository.TaskRepository
	// reports resolves who to notify when work lands on a client's board. A list
	// can belong to a channel now, so raising a task there is raising a report.
	reports *repository.ReportRepository
	// orgs answers "may this person be given this card" — the check the report
	// side has always made and this one didn't.
	orgs *repository.OrganizationRepository
	// hub broadcasts board changes so every open console reflects them without
	// polling. Optional: a nil hub simply means no live updates.
	hub *events.Hub
	// avisos escribe en la campana. Opcional como el hub: un servicio sin él
	// simplemente no deja constancia, que es lo que hacen todas las pruebas que
	// no van de esto.
	avisos *avisos
}

// WithNotifier deja constancia de los comentarios, para que uno que llegó con
// la app cerrada se pueda leer después. Sin esto sólo había aviso en vivo.
func (s *TaskService) WithNotifier(n Notifier) *TaskService {
	s.avisos = &avisos{inbox: n, items: s.reports, orgs: s.orgs}
	return s
}

// NewTaskService takes the report repository as well, because a list can belong
// to a client's channel: work raised there is a report on their board, and it
// has to be numbered and announced like one.
func NewTaskService(
	repo *repository.TaskRepository,
	reports *repository.ReportRepository,
	orgs *repository.OrganizationRepository,
	hub *events.Hub,
) *TaskService {
	return &TaskService{repo: repo, reports: reports, orgs: orgs, hub: hub}
}

// publish fans a board change out to the task's organization. Payloads stay
// minimal — an id and enough context to decide whether to refetch — because the
// receiver reloads authoritative state anyway.
func (s *TaskService) publish(kind, orgID, listID, taskID string) {
	if s.hub == nil || orgID == "" {
		return
	}
	s.hub.Publish(events.Event{
		Type:  kind,
		OrgID: orgID,
		Data: map[string]string{
			"listId": listID,
			"taskId": taskID,
		},
	})
}

// defaultStatuses is what a new list starts with — a board is useless with zero
// columns, and these three cover the common flow without forcing a choice.
func defaultStatuses() []domain.TaskStatus {
	specs := []struct {
		name, color string
		kind        domain.TaskStatusKind
	}{
		{"Open", "#7D8BA3", domain.StatusKindOpen},
		{"In progress", "#20D9E8", domain.StatusKindActive},
		{"Done", "#34D399", domain.StatusKindDone},
	}
	out := make([]domain.TaskStatus, len(specs))
	prev := ""
	for i, s := range specs {
		prev = rank.Between(prev, "")
		out[i] = domain.TaskStatus{Name: s.name, Color: s.color, Kind: s.kind, Rank: prev}
		out[i].ID = uuid.NewString()
	}
	return out
}

// ─── Tree / spaces ────────────────────────────────────────────────────────────

func (s *TaskService) Tree(orgIDs []string, superadmin bool, orgID string) ([]domain.SpaceTree, error) {
	return s.repo.Tree(orgIDs, superadmin, orgID)
}

func (s *TaskService) ListOpen(orgIDs []string, superadmin bool, orgID string, limit int, f domain.OpenTaskFilter) ([]domain.OpenTask, error) {
	return s.repo.ListOpen(orgIDs, superadmin, orgID, limit, f)
}

func (s *TaskService) CreateSpace(req domain.CreateSpaceRequest) (*domain.TaskSpace, error) {
	sp := &domain.TaskSpace{OrgID: req.OrgID, Name: req.Name, Color: req.Color}
	sp.ID = uuid.NewString()
	if err := s.repo.CreateSpace(sp); err != nil {
		return nil, err
	}
	return sp, nil
}

func (s *TaskService) FindSpace(id string) (*domain.TaskSpace, error) { return s.repo.FindSpace(id) }

func (s *TaskService) RenameSpace(id string, req domain.RenameRequest) error {
	return s.repo.UpdateSpace(id, req.Name, req.Color)
}

func (s *TaskService) DeleteSpace(id string) error { return s.repo.DeleteSpace(id) }

// MoveSpace reorders a space among the org's spaces.
func (s *TaskService) MoveSpace(id string, req domain.MoveNodeRequest) error {
	return s.repo.MoveSpace(id, s.rankBetween("task_spaces", req.AfterID, req.BeforeID))
}

// Neighbours turns a "shift one position" request into the pair of ids the rank
// helper needs, so the client doesn't have to know about ranks at all.
//
// ok=false means the move is a no-op (already at that edge). This matters:
// ("", "") on its own is ambiguous — it also describes "the only sibling" — and
// feeding it to rank.Between would assign a fixed rank and *relocate* the row
// instead of leaving it where it is.
func (s *TaskService) Neighbours(table, scopeCol, scopeID, id string, up bool) (afterID, beforeID string, ok bool) {
	ids := s.repo.Siblings(table, scopeCol, scopeID)
	idx := -1
	for i, v := range ids {
		if v == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return "", "", false
	}
	if up {
		if idx == 0 {
			return "", "", false // already first
		}
		if idx == 1 {
			return "", ids[0], true // becomes the new first
		}
		return ids[idx-2], ids[idx-1], true
	}
	if idx >= len(ids)-1 {
		return "", "", false // already last
	}
	if idx == len(ids)-2 {
		return ids[len(ids)-1], "", true // becomes the new last
	}
	return ids[idx+1], ids[idx+2], true
}

// ─── Folders / lists ──────────────────────────────────────────────────────────

func (s *TaskService) CreateFolder(spaceID, name string, parentID *string) (*domain.TaskFolder, error) {
	f := &domain.TaskFolder{SpaceID: spaceID, Name: name, ParentFolderID: parentID}
	f.ID = uuid.NewString()
	if err := s.repo.CreateFolder(f); err != nil {
		return nil, err
	}
	return f, nil
}

func (s *TaskService) RenameFolder(id, name string) error { return s.repo.RenameFolder(id, name) }

// MoveFolder reorders a folder among its space's folders.
// ErrFolderCycle: a folder cannot end up inside itself, directly or through any
// chain of parents.
//
// Worth its own guard rather than trusting the client, because the failure is
// not an error message — it is a subtree that vanishes from the navigator. The
// tree is built by walking down from the space, and a ring is reachable from
// nothing, so the folder and everything under it simply stop being drawn while
// every row is still perfectly there in the database.
var ErrFolderCycle = errors.New("a folder cannot be moved inside itself")

// MoveFolder reorders a folder among its siblings and, optionally, puts it
// inside another folder of the same space.
func (s *TaskService) MoveFolder(id string, req domain.MoveNodeRequest) error {
	if req.FolderID != nil {
		f, err := s.repo.FindFolder(id)
		if err != nil {
			return err
		}
		padres, err := s.repo.FolderParents(f.SpaceID)
		if err != nil {
			return err
		}
		// Walk up from the proposed parent. Reaching the folder being moved
		// means the move would close a ring. Bounded by the number of folders
		// so a ring already in the data can't spin here forever.
		padres[id] = req.FolderID
		for cur, pasos := req.FolderID, 0; cur != nil && pasos <= len(padres); pasos++ {
			if *cur == id {
				return ErrFolderCycle
			}
			cur = padres[*cur]
		}
	}
	return s.repo.MoveFolder(id, req.FolderID, s.rankBetween("task_folders", req.AfterID, req.BeforeID))
}
func (s *TaskService) DeleteFolder(id string) error { return s.repo.DeleteFolder(id) }
func (s *TaskService) FindFolder(id string) (*domain.TaskFolder, error) {
	return s.repo.FindFolder(id)
}

func (s *TaskService) CreateList(spaceID string, req domain.CreateListRequest) (*domain.TaskList, error) {
	l := &domain.TaskList{SpaceID: spaceID, FolderID: req.FolderID, Name: req.Name}
	l.ID = uuid.NewString()
	if err := s.repo.CreateList(l, defaultStatuses()); err != nil {
		return nil, err
	}
	return l, nil
}

func (s *TaskService) FindList(id string) (*domain.TaskList, error) { return s.repo.FindList(id) }
func (s *TaskService) RenameList(id, name string) error             { return s.repo.RenameList(id, name) }

// BindList points a list at a tenant's channel, and makes it where that
// channel's incoming reports land.
//
// Those two go together on purpose. Saying "this list is portento's" and then
// having portento's reports arrive somewhere else would be a setting that lies.
// Binding a second list moves the inbox to it — the last explicit choice wins,
// which is the only rule that doesn't need a second control to explain it.
// Desvincular se rechaza. La invariante es que un canal tiene siempre
// exactamente una bandeja y que es una lista de verdad; **no** que la bandeja no
// se pueda mover. Repuntarla es legítimo —se reorganiza un tablero, se separa un
// cliente en otro espacio— y congelarla dejaría un canal mal puesto mal para
// siempre. Lo que no puede pasar es quedarse en nada.
//
// Y antes se quedaba: con proyecto vacío esto limpiaba `task_lists.project_id` y
// salía **antes** de tocar la bandeja, así que el canal seguía entregando en una
// lista que ya no se declaraba suya y el árbol no lo decía.
func (s *TaskService) BindList(listID, projectID string) error {
	if projectID == "" {
		if enUso, err := s.repo.ChannelDeliveringInto(listID); err != nil {
			return err
		} else if enUso {
			return repository.ErrChannelNeedsInbox
		}
		return s.repo.BindListToChannel(listID, "")
	}
	if err := s.repo.BindListToChannel(listID, projectID); err != nil {
		return err
	}
	return s.repo.SetChannelInbox(projectID, listID)
}

// BindSpace binds a whole space. It does not move any inbox: a space-level
// setting is about what belongs where, and quietly redirecting a tenant's
// incoming reports from two levels up would be too far from the action.
func (s *TaskService) BindSpace(spaceID, projectID string) error {
	return s.repo.BindSpaceToChannel(spaceID, projectID)
}
func (s *TaskService) DeleteList(id string) error { return s.repo.DeleteList(id) }

// MoveList reorders a list among its siblings, optionally into another folder.
func (s *TaskService) MoveList(id string, req domain.MoveNodeRequest) error {
	newRank := s.rankBetween("task_lists", req.AfterID, req.BeforeID)
	return s.repo.MoveList(id, req.FolderID, newRank)
}

// rankBetween resolves the two neighbour ids into a rank for the moved row.
func (s *TaskService) rankBetween(table, afterID, beforeID string) string {
	var a, b string
	if afterID != "" {
		a = s.repo.RankOf(table, afterID)
	}
	if beforeID != "" {
		b = s.repo.RankOf(table, beforeID)
	}
	return rank.Between(a, b)
}

// ─── Statuses ─────────────────────────────────────────────────────────────────

func (s *TaskService) Statuses(listID string) ([]domain.TaskStatus, error) {
	return s.repo.Statuses(listID)
}

// ErrColumnsAreFixed: the four columns are a rendering of the shared state
// machine, so there is nothing to create, rename, reorder or delete.
//
// Answered rather than quietly ignored. An older build of the app still offers
// these buttons, and a 200 that did nothing would let someone rename a column,
// see it snap back, and go looking for a bug that isn't there.
var ErrColumnsAreFixed = errors.New("board columns are fixed and cannot be changed")

func (s *TaskService) CreateStatus(string, domain.CreateStatusRequest) (*domain.TaskStatus, error) {
	return nil, ErrColumnsAreFixed
}

func (s *TaskService) FindStatus(id string) (*domain.TaskStatus, error) {
	return s.repo.FindStatus(id)
}

func (s *TaskService) UpdateStatus(string, domain.UpdateStatusRequest) error {
	return ErrColumnsAreFixed
}

func (s *TaskService) MoveStatus(string, string, string) error { return ErrColumnsAreFixed }

func (s *TaskService) DeleteStatus(string, string) error { return ErrColumnsAreFixed }

// ─── Tasks ────────────────────────────────────────────────────────────────────

func (s *TaskService) Board(listID string) (*domain.BoardResponse, error) {
	list, err := s.repo.FindList(listID)
	if err != nil {
		return nil, err
	}
	statuses, err := s.repo.Statuses(listID)
	if err != nil {
		return nil, err
	}
	cards, err := s.repo.Board(listID)
	if err != nil {
		return nil, err
	}
	return &domain.BoardResponse{
		List:     domain.ListSummary{ID: list.ID, Name: list.Name, TaskCount: int64(len(cards))},
		Statuses: statuses,
		Tasks:    cards,
	}, nil
}

// CreateTask drops a task in the requested column, defaulting to the first one.
func (s *TaskService) CreateTask(ctx context.Context, list *domain.TaskList, orgID, userID string, req domain.CreateTaskRequest) (*domain.Task, error) {
	// A retry with the same key must not produce a second card. Checked before
	// doing any work, and backed by a partial unique index for the case where two
	// retries land at once.
	if req.IdempotencyKey != "" {
		if existing, err := s.repo.FindTaskByIdempotencyKey(list.ID, req.IdempotencyKey); err == nil && existing != nil {
			return existing, nil
		}
	}

	// A status id off the board, or nothing at all: new work starts in the first
	// column either way.
	status := domain.ReportPending
	if req.StatusID != "" {
		parsed, ok := domain.SplitSyntheticStatusID(req.StatusID)
		if !ok {
			return nil, ErrBadStatus
		}
		status = parsed
	}
	priority := domain.ItemPriority(req.Priority).Canonical()
	if priority == "" {
		priority = domain.ItemPriorityNone
	}

	// Whose board does this reach? The list's channel, or the space's above it.
	// Empty means nobody outside, and then the choice below doesn't apply.
	channel, err := s.repo.EffectiveChannel(list.ID)
	if err != nil {
		return nil, err
	}
	if channel != "" && req.Visibility == domain.VisibilityInternal {
		channel = "" // kept to us, on purpose
	}

	// The column says what it means. An item with no channel is nobody's to see,
	// so it is stored as internal rather than "public with nowhere to go" — a
	// value that reads as client-visible to anyone who filters on it alone.
	visibility := domain.VisibilityInternal
	if channel != "" {
		visibility = domain.VisibilityPublic
	}

	t := &domain.Task{
		ListID:         list.ID,
		ProjectID:      channel,
		Visibility:     visibility,
		Status:         status,
		Origin:         "internal",
		OrgID:          orgID,
		Title:          req.Title,
		Description:    req.Description,
		IdempotencyKey: req.IdempotencyKey,
		Priority:       priority,
		CreatedByID:    userID,
		DueAt:          req.DueAt,
	}
	// A subtask of a client-visible item stays internal: inheriting the channel
	// would spend one of their folio numbers on a checklist line and put it on
	// their board as if it were a ticket of its own.
	if req.ParentID != "" {
		t.ProjectID = ""
		// Only accept a parent from the same list: a subtask that lived in another
		// list (or org) would be unreachable from its parent's board.
		parent, err := s.repo.FindTask(req.ParentID)
		if err != nil {
			return nil, err
		}
		if parent.ListID != list.ID {
			return nil, ErrParentOther
		}
		t.ParentID = &req.ParentID
	}
	t.ID = uuid.NewString()
	if err := s.repo.CreateTask(t, list.SpaceID); err != nil {
		return nil, err
	}
	// After the row exists, and through the same path an edit uses — which is
	// what checks that each of them is actually in this organization. A failure
	// here leaves the task created and unassigned rather than swallowing it:
	// losing the work because the assignment was refused would be worse than
	// having to name somebody twice.
	if len(req.AssigneeIDs) > 0 {
		s.avisos.asignada(domain.ViaFrom(ctx), orgID, t.ID, userID, req.AssigneeIDs, t.Title)
		if err := s.setAssignees(t.ID, req.AssigneeIDs); err != nil {
			return t, err
		}
	}
	s.publish("task:new", orgID, list.ID, t.ID)
	return t, nil
}

func (s *TaskService) FindTask(id string) (*domain.Task, error) { return s.repo.FindTask(id) }

// actorID es quien edita: hace falta para no avisarle de que se ha asignado
// algo a sí mismo, que es la mitad de las asignaciones que existen.
func (s *TaskService) UpdateTask(ctx context.Context, id, actorID string, req domain.UpdateTaskRequest) error {
	// Captured before the write so a description edit can be compared against
	// what it replaced (see dropRemovedAttachments).
	var oldDescription string
	if req.Description != nil {
		if prev, err := s.repo.FindTask(id); err == nil {
			oldDescription = prev.Description
		}
	}

	fields := map[string]any{}
	if req.Title != nil {
		fields["title"] = *req.Title
	}
	if req.Description != nil {
		fields["description"] = *req.Description
	}
	if req.Priority != nil {
		fields["priority"] = *req.Priority
	}
	if req.StartAt != nil {
		fields["start_at"] = req.StartAt
	}
	if req.DueAt != nil {
		fields["due_at"] = req.DueAt
	}
	if req.Archived != nil {
		if *req.Archived {
			now := time.Now()
			fields["archived_at"] = &now
		} else {
			fields["archived_at"] = nil
		}
	}
	// Visibility last, and separately: it is the only field here that changes who
	// can read the item, so it goes through the code that knows what a channel is
	// rather than being another key in the map.
	// Moving between lists is its own operation: it has to carry the denormalised
	// space with it and give the card a place in the destination's order, neither
	// of which is a field patch.
	if req.ListID != nil && *req.ListID != "" {
		if err := s.repo.MoveTaskToList(id, *req.ListID); err != nil {
			return err
		}
	}

	if req.Visibility != nil {
		task, err := s.repo.FindTask(id)
		if err != nil {
			return err
		}
		if err := s.setVisibility(task, *req.Visibility); err != nil {
			return err
		}
	}

	if err := s.repo.UpdateTask(id, fields); err != nil {
		return err
	}
	if req.TagIDs != nil {
		if err := s.repo.SetTags(id, *req.TagIDs); err != nil {
			return err
		}
	}
	if req.AssigneeIDs != nil {
		// La diferencia, antes de escribirla: guardar responsables reemplaza la
		// lista entera, así que sin esto se avisaría otra vez a quien ya la
		// tenía cada vez que alguien toca cualquier otro campo.
		nuevos := s.reciénAsignados(id, *req.AssigneeIDs)
		if err := s.setAssignees(id, *req.AssigneeIDs); err != nil {
			return err
		}
		if t, err := s.repo.FindTask(id); err == nil {
			s.avisos.asignada(domain.ViaFrom(ctx), t.OrgID, id, actorID, nuevos, t.Title)
		}
	}
	if req.Description != nil {
		s.dropRemovedAttachments(id, oldDescription, *req.Description)
	}
	if t, err := s.repo.FindTask(id); err == nil {
		s.publish("task:update", t.OrgID, t.ListID, t.ID)
	}
	return nil
}

// MoveTask places a task between two neighbours, stamping completed_at when it
// lands in (or leaves) a "done" column so reporting doesn't depend on names.
// MoveTask takes the person doing it, not just the card.
//
// Only so the event can name them: every console in the organization hears the
// same stream, including the one that just dragged the card, and without a name
// on the event it announces the move back to whoever made it.
func (s *TaskService) MoveTask(ctx context.Context, id, userID string, req domain.MoveTaskRequest) error {
	next, ok := domain.SplitSyntheticStatusID(req.StatusID)
	if !ok {
		return ErrBadStatus
	}
	task, err := s.repo.FindTask(id)
	if err != nil {
		return err
	}
	// The same machine the report side has always used. A board that let a card
	// take a route the API refuses would show a state the server disagrees with
	// until the next refresh.
	if task.Status != next && !task.Status.CanTransitionTo(next) {
		return ErrBadTransition
	}

	// Sticky, which is the report semantics rather than the task one: the date
	// something was first finished is a fact, and reopening a card doesn't unmake
	// it. Tasks used to clear this on the way out of a done column, so "when did
	// we finish it" was lost the moment anyone reopened anything.
	resolvedAt := task.ResolvedAt
	if domain.IsFinished(next) && resolvedAt == nil {
		now := time.Now()
		resolvedAt = &now
	}

	newRank := s.rankBetween("items", req.AfterID, req.BeforeID)
	if err := s.repo.MoveTask(id, next, newRank, resolvedAt); err != nil {
		return err
	}

	// Dragging a client's report across a column is the same act as triaging it
	// from the reports page, so it has to leave the same trace: the note in the
	// thread they can read, and the event their app is waiting for. A board that
	// changed the state quietly would be a board that lies to the customer.
	if task.IsVisibleToChannel() && task.Status != next {
		if err := s.reports.CreateComment(newSystemComment(id,
			fmt.Sprintf("status: %s → %s", task.Status, next))); err != nil {
			return err
		}
		emitItemEvent(s.hub, s.reports, "report:status", id, "team", map[string]any{
			"reportId": id, "status": string(next), "actorId": userID,
		})
	}
	s.publish("task:move", task.OrgID, task.ListID, task.ID)
	// Sólo cuando cambia de estado. Reordenar dentro de la misma columna es
	// mover una tarjeta de sitio, no una noticia.
	if task.Status != next {
		s.avisos.estado(domain.ViaFrom(ctx), task.OrgID, id, userID,
			"Moved to "+string(next), task.Title)
	}
	return nil
}

func (s *TaskService) DeleteTask(id string) error {
	// Capture the routing info before the row is gone.
	t, err := s.repo.FindTask(id)
	if err != nil {
		return err
	}
	if err := s.repo.DeleteTask(id); err != nil {
		return err
	}
	s.publish("task:delete", t.OrgID, t.ListID, t.ID)
	return nil
}

func nombreDe(l *domain.TaskList) string {
	if l == nil {
		return ""
	}
	return l.Name
}

func nombreDeEspacio(sp *domain.TaskSpace) string {
	if sp == nil {
		return ""
	}
	return sp.Name
}

// Detail assembles everything the task drawer needs in one response.
func (s *TaskService) Detail(id string) (*domain.TaskDetail, error) {
	t, err := s.repo.FindTask(id)
	if err != nil {
		return nil, err
	}
	// Un item sin lista se lee igual, sin columna.
	//
	// Antes esto devolvía «list not found» y el handler lo convertía en un 500,
	// así que un reporte huérfano no sólo no salía en ningún tablero: tampoco se
	// podía abrir para ver qué decía. Un dato incompleto no es un fallo del
	// servidor, y negarse a enseñar lo que sí hay no ayuda a nadie.
	var list *domain.TaskList
	var space *domain.TaskSpace
	if t.ListID != "" {
		if list, err = s.repo.FindList(t.ListID); err != nil && !errors.Is(err, repository.ErrListNotFound) {
			return nil, err
		}
	}
	if list != nil {
		if space, err = s.repo.FindSpace(list.SpaceID); err != nil {
			return nil, err
		}
	}
	// Synthesised, not looked up: the column is a rendering of the state now.
	status := domain.BoardStatusFor(t.ListID, t.Status)
	tags, err := s.repo.TagsOf(id)
	if err != nil {
		return nil, err
	}
	assignees, err := s.repo.AssigneesOf(id)
	if err != nil {
		return nil, err
	}
	comments, err := s.repo.Comments(id)
	if err != nil {
		return nil, err
	}
	attachments, err := s.repo.Attachments(id, nil)
	if err != nil {
		return nil, err
	}
	for i := range attachments {
		attachments[i].NormalizeURL()
	}
	// Comment attachments too — same reason (pre-proxy rows hold bucket URLs).
	for i := range comments {
		for j := range comments[i].Attachments {
			comments[i].Attachments[j].NormalizeURL()
		}
	}
	subtasks, err := s.repo.Subtasks(id)
	if err != nil {
		return nil, err
	}

	detail := &domain.TaskDetail{
		// Spelt the way the task API has always spelt it. The board already did
		// this and the detail did not, so opening a card whose priority came from
		// the report side handed the app a value its own table had no entry for —
		// and reading a field off that undefined took the whole screen down.
		Task:      withTaskWirePriority(*t),
		// Vacíos cuando el item no está en ninguna lista. La pantalla lo pinta
		// como lo que es —una tarjeta sin sitio— en vez de no pintar nada.
		ListName:  nombreDe(list),
		SpaceName: nombreDeEspacio(space),
		Status:    status,
		Tags:      tags, Assignees: assignees, Comments: comments, Attachments: attachments,
		Subtasks: subtasks,
	}
	// What this card is when it arrived through a client's channel. Guarded on
	// ProjectID rather than on the fields being non-empty: an internal task must
	// never be handed a folio, because a folio names a number in a client's
	// sequence and this one has none.
	if t.ProjectID != "" {
		if slug := s.repo.ProjectSlug(t.ProjectID); slug != "" {
			detail.ProjectSlug = slug
			detail.Folio = domain.Folio(slug, t.Seq)
		}
		// Best-effort, exactly as the report facade does it: a purged blob or a
		// missing key means no timeline, not a failed request. Losing the
		// breadcrumbs is not a reason to refuse to open the card.
		if len(t.Telemetry) > 0 {
			if plain, err := repository.DecryptTelemetry(t.Telemetry); err == nil && json.Valid(plain) {
				detail.Telemetry = plain
			}
		}
	}

	// When this task is a subtask, hand the drawer enough to link back up.
	if t.ParentID != nil {
		if p, err := s.repo.FindTask(*t.ParentID); err == nil {
			detail.Parent = &domain.TaskCard{ID: p.ID, Seq: p.Seq, Title: p.Title,
				StatusID: domain.SyntheticStatusID(p.ListID, p.Status)}
		}
	}
	return detail, nil
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

func (s *TaskService) ListTags(orgIDs []string, superadmin bool, orgID string) ([]domain.TaskTag, error) {
	return s.repo.ListTags(orgIDs, superadmin, orgID)
}

func (s *TaskService) CreateTag(req domain.CreateTagRequest) (*domain.TaskTag, error) {
	t := &domain.TaskTag{OrgID: req.OrgID, Name: req.Name, Color: req.Color}
	t.ID = uuid.NewString()
	if err := s.repo.CreateTag(t); err != nil {
		return nil, err
	}
	return t, nil
}

// setVisibility publishes an item to a client's board or takes it back.
//
// Taking it back leaves the folio spent: the client may already have quoted that
// number, and reusing it would make the name mean two things. Their numbering
// keeps a gap, which is the truthful record of what happened.
//
// Publishing one that was internal gives it the next number of that channel and
// announces it, exactly as if it had been created visible.
func (s *TaskService) setVisibility(task *domain.Task, want domain.ItemVisibility) error {
	channel, err := s.repo.EffectiveChannel(task.ListID)
	if err != nil {
		return err
	}
	switch {
	case want == domain.VisibilityInternal && task.IsVisibleToChannel():
		if err := s.repo.RetractFromChannel(task.ID); err != nil {
			return err
		}
		// No event: there is no "unpublish" in the contract, and inventing one
		// would have every receiver guessing. It simply stops being listed.
		task.Visibility = domain.VisibilityInternal

	case want == domain.VisibilityPublic && !task.IsVisibleToChannel() && channel != "":
		seq, err := s.repo.PublishToChannel(task.ID, channel)
		if err != nil {
			return err
		}
		task.ProjectID, task.Seq = channel, seq
		task.Visibility = domain.VisibilityPublic
		// Sin aviso en la campana, y a propósito. Este `report:new` lo causa
		// alguien del equipo publicando en el tablero de un cliente; el de
		// `report.go` lo causa el cliente levantando algo. Sólo el segundo es
		// noticia para toda la organización — avisar a todo el mundo de cada
		// tarjeta que publica un compañero es justo el ruido que hace que se
		// deje de mirar la campana. Ver la regla en avisos.go.
		emitItemEvent(s.hub, s.reports, "report:new", task.ID, "team", map[string]any{
			"reportId": task.ID, "projectId": channel, "title": task.Title,
		})
	}
	return nil
}

// withTaskWirePriority returns the item with its priority in the vocabulary the
// task API answers in.
//
// One helper rather than a conversion at each call site, because the one that
// was missed is how this got out: a value correct everywhere else, wrong on the
// single path a person actually looks at.
func withTaskWirePriority(t domain.Item) domain.Item {
	t.Priority = t.Priority.TaskWire()
	return t
}

// setAssignees replaces who is responsible, under the rules the report side has
// always applied — which this side never did.
//
// Two of them. **Membership is checked**: assigning someone outside the
// organization used to be a plain insert here, so a card could be handed to
// somebody who cannot open it. And **the client is told**, because on their
// board "assigned to Ana" is how they learn anyone picked it up; a card that
// changed hands silently on our side read as untouched on theirs.
// reciénAsignados son los que no estaban antes. Un fallo al leer devuelve nada:
// avisar de más por no haber podido comparar es peor que no avisar.
func (s *TaskService) reciénAsignados(itemID string, quedan []string) []string {
	antes, err := s.repo.AssigneesOf(itemID)
	if err != nil {
		return nil
	}
	ya := make(map[string]bool, len(antes))
	for _, a := range antes {
		ya[a.ID] = true
	}
	var nuevos []string
	for _, id := range quedan {
		if !ya[id] {
			nuevos = append(nuevos, id)
		}
	}
	return nuevos
}

func (s *TaskService) setAssignees(itemID string, userIDs []string) error {
	task, err := s.repo.FindTask(itemID)
	if err != nil {
		return err
	}
	for _, uid := range userIDs {
		if _, err := s.orgs.GetMembership(task.OrgID, uid); err != nil {
			return ErrAssigneeNotMember
		}
	}

	before, _ := s.reports.PrimaryAssignee(itemID)
	if err := s.repo.SetAssignees(itemID, userIDs); err != nil {
		return err
	}
	after, _ := s.reports.PrimaryAssignee(itemID)

	// Only the person the tenant is shown, and only when it actually changed:
	// their thread is a conversation, not a log of our staffing.
	if task.IsVisibleToChannel() && before != after {
		body := "unassigned"
		if after != "" {
			body = "assigned to " + s.reports.UsernameByID(after)
		}
		if err := s.reports.CreateComment(newSystemComment(itemID, body)); err != nil {
			return err
		}
	}
	return nil
}

// ─── Comments / attachments ───────────────────────────────────────────────────

// newComment builds a comment with its audience decided at construction.
//
// A constructor rather than a struct literal at each call site: `visibility`
// defaults to public at the column level — that is what lets the contract test
// insert bare rows and still have the reporter see them — so leaving it unset
// here would quietly publish a team note. Making it a parameter of construction
// means it cannot be forgotten.
func newComment(itemID, authorUserID, body string, visibility domain.ItemVisibility) *domain.ItemComment {
	var author *string
	if authorUserID != "" {
		author = &authorUserID
	}
	c := &domain.ItemComment{
		ItemID:       itemID,
		Kind:         domain.CommentKindUser,
		Visibility:   visibility,
		AuthorUserID: author,
		Body:         body,
	}
	c.ID = uuid.NewString()
	return c
}

func (s *TaskService) AddComment(ctx context.Context, taskID, userID, body string, want domain.ItemVisibility) (*domain.TaskComment, error) {
	task, err := s.repo.FindTask(taskID)
	if err != nil {
		return nil, err
	}

	// The same rule as raising the work: on something a client can see, saying
	// nothing means they read this too. Anything else would make the thread in
	// their board a partial transcript — they see a reply, we see three, and
	// nobody can tell which is which from either side.
	//
	// On an item no client can see, every comment is internal by definition.
	visibility := domain.VisibilityInternal
	if task.IsVisibleToChannel() && want != domain.VisibilityInternal {
		visibility = domain.VisibilityPublic
	}

	// Through the constructor, always: visibility is the one field on a comment
	// that can leak, and the column default is the permissive one so the contract
	// test keeps working. Nothing writes this table around it.
	c := newComment(taskID, userID, body, visibility)
	if err := s.repo.CreateComment(c); err != nil {
		return nil, err
	}
	s.publish("task:comment", task.OrgID, task.ListID, task.ID)
	// Siempre de un compañero: este camino pide un usuario de cac. Así que va a
	// los del hilo y no a la organización entera.
	s.avisos.comentario(false, domain.ViaFrom(ctx), task.OrgID, task.ID, userID,
		tituloDeRespuesta(false, ""), task.Title)
	if visibility == domain.VisibilityPublic {
		// The client is owed this the same way they are owed a reply written from
		// the reports page — it is the same thread.
		emitItemEvent(s.hub, s.reports, "report:comment", taskID, "team", map[string]any{
			// actorId so the console that wrote it doesn't announce it back. See
			// the same field in report.go: "team" names a side, not a person.
			"reportId": taskID, "commentId": c.ID, "actorId": userID,
		})
	}
	return c, nil
}

func (s *TaskService) FindComment(id string) (*domain.TaskComment, error) {
	return s.repo.FindComment(id)
}

func (s *TaskService) EditComment(id, body string) error {
	// Same contract as a description edit: an inline image the author just removed
	// stops being listed as an attachment.
	before, taskID := "", ""
	if c, err := s.repo.FindComment(id); err == nil {
		before, taskID = c.Body, c.ItemID
	}
	if err := s.repo.UpdateComment(id, body); err != nil {
		return err
	}
	if taskID != "" {
		s.dropRemovedAttachments(taskID, before, body)
	}
	return nil
}

// DeleteComment removes the comment. Files it cited are detached with it, unless
// the description (or another comment) still references them.
func (s *TaskService) DeleteComment(id string) error {
	before, taskID := "", ""
	if c, err := s.repo.FindComment(id); err == nil {
		before, taskID = c.Body, c.ItemID
	}
	if err := s.repo.DeleteComment(id); err != nil {
		return err
	}
	if taskID != "" {
		s.dropRemovedAttachments(taskID, before, "")
	}
	return nil
}

// dropRemovedAttachments detaches files whose inline reference the user just
// deleted, so removing an image from the markdown doesn't leave it listed under
// Attachments forever.
//
// Deliberately narrow: only ids that were in the *previous* text and are gone
// from the new one qualify. Pruning every unreferenced attachment instead would
// race with editing — an image pasted seconds ago has a row but isn't in any
// saved text yet, and saving something else would delete it mid-edit.
//
// A file still cited by any comment stays. The blob itself is left in storage;
// only the row (and therefore the listing) goes.
func (s *TaskService) dropRemovedAttachments(taskID, before, after string) {
	if before == "" || before == after {
		return
	}
	atts, err := s.repo.Attachments(taskID, nil)
	if err != nil {
		return
	}
	// Everything that still cites the file: the task's own description plus every
	// remaining comment. `after` covers whichever of those is being edited.
	var elsewhere string
	if t, err := s.repo.FindTask(taskID); err == nil {
		elsewhere += t.Description
	}
	if cs, err := s.repo.Comments(taskID); err == nil {
		for _, c := range cs {
			elsewhere += c.Body
		}
	}
	for _, a := range atts {
		if !strings.Contains(before, a.ID) || strings.Contains(after, a.ID) {
			continue
		}
		if strings.Contains(elsewhere, a.ID) {
			continue
		}
		if err := s.repo.DeleteAttachment(a.ID); err != nil {
			lg.Error("drop removed attachment " + a.ID + ": " + err.Error())
		}
	}
}

func (s *TaskService) AddAttachment(a *domain.TaskAttachment) error {
	// Only mint when the caller didn't: the upload handler needs the id *before*
	// the insert because the attachment's URL embeds it. Overwriting it here
	// stored a row whose URL pointed at an id that never existed, so every image
	// 404'd through the proxy.
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	return s.repo.CreateAttachment(a)
}

func (s *TaskService) FindAttachment(id string) (*domain.TaskAttachment, error) {
	return s.repo.FindAttachment(id)
}

func (s *TaskService) DeleteAttachment(id string) error { return s.repo.DeleteAttachment(id) }

// OrgIDForTask is what the attachment proxy authorizes against: it runs outside
// the JWT middleware, so it resolves the owning org itself.
func (s *TaskService) OrgIDForTask(taskID string) (string, error) {
	t, err := s.repo.FindTask(taskID)
	if err != nil {
		return "", err
	}
	return t.OrgID, nil
}

// SortSpace and SortFolder put a container's children in alphabetical order.
func (s *TaskService) SortSpace(spaceID string) error {
	return s.repo.SortChildren(spaceID, nil)
}

func (s *TaskService) SortFolder(folderID string) error {
	f, err := s.repo.FindFolder(folderID)
	if err != nil {
		return err
	}
	return s.repo.SortChildren(f.SpaceID, &f.ID)
}

// Watch and Unwatch put somebody on, or off, a task's followers.
//
// Following is not assignment: it says "tell me how this goes" without saying
// "this is mine to do". They are checked the same way, though — you can only
// follow work you can already see, which resolveTask has decided by the time
// this is called.
func (s *TaskService) Watch(taskID, userID string) error   { return s.repo.Watch(taskID, userID) }
func (s *TaskService) Unwatch(taskID, userID string) error { return s.repo.Unwatch(taskID, userID) }
func (s *TaskService) Watchers(taskID string) ([]string, error) {
	return s.repo.Watchers(taskID)
}

// ─── Duplicating a folder, and moving branches between spaces ────────────────

// ErrDifferentOrganization: the target space belongs to somebody else.
//
// The hard fence of this whole module. Spaces are how one client's work is kept
// apart from another's, and a move that crossed organizations would carry it
// over in a single drag, silently and with no way to notice afterwards.
var ErrDifferentOrganization = errors.New("that space belongs to another organization")

// DuplicateFolder copies a folder, the folders inside it however deep, and the
// lists in all of them.
//
// **Structure only: no tasks are copied.** Duplicating a folder is how a
// template gets reused, and carrying the work across with it would mint new
// folios for items that already exist, duplicate their comments and
// attachments, and leave two copies of the same job for someone to reconcile.
// The empty shape is the useful half.
func (s *TaskService) DuplicateFolder(id, name string) (*domain.TaskFolder, error) {
	origen, err := s.repo.FindFolder(id)
	if err != nil {
		return nil, err
	}
	folders, lists, err := s.repo.FolderSubtree(id)
	if err != nil {
		return nil, err
	}

	// Old id → new id, so the copied folders keep pointing at each other rather
	// than at the originals.
	nuevoID := make(map[string]string, len(folders))
	for _, f := range folders {
		nuevoID[f.ID] = uuid.NewString()
	}

	copias := make([]domain.TaskFolder, 0, len(folders))
	for _, f := range folders {
		c := domain.TaskFolder{SpaceID: f.SpaceID, Name: f.Name, Rank: f.Rank}
		c.ID = nuevoID[f.ID]
		if f.ID == origen.ID {
			if name != "" {
				c.Name = name
			}
			c.ParentFolderID = origen.ParentFolderID
			c.Rank = s.repo.LastRankIn("task_folders", f.SpaceID)
		} else if f.ParentFolderID != nil {
			padre := nuevoID[*f.ParentFolderID]
			c.ParentFolderID = &padre
		}
		copias = append(copias, c)
	}

	copiaLists := make([]domain.TaskList, 0, len(lists))
	statuses := make(map[string][]domain.TaskStatus, len(lists))
	for _, l := range lists {
		padre := nuevoID[*l.FolderID]
		c := domain.TaskList{SpaceID: l.SpaceID, FolderID: &padre, Name: l.Name, Rank: l.Rank}
		c.ID = uuid.NewString()
		// The channel binding is deliberately not carried over. A copy is a new
		// container, and inheriting "a client can see this" without anyone
		// saying so is the one mistake here that would be invisible.
		copiaLists = append(copiaLists, c)
		statuses[c.ID] = defaultStatuses()
	}

	if err := s.repo.CreateBranch(copias, copiaLists, statuses); err != nil {
		return nil, err
	}
	return &copias[0], nil
}

// MoveFolderToSpace re-homes a folder and everything under it.
func (s *TaskService) MoveFolderToSpace(folderID, spaceID string) error {
	origen, err := s.repo.FindFolder(folderID)
	if err != nil {
		return err
	}
	if err := s.mismaOrganizacion(origen.SpaceID, spaceID); err != nil {
		return err
	}
	folders, lists, err := s.repo.FolderSubtree(folderID)
	if err != nil {
		return err
	}
	folderIDs := make([]string, len(folders))
	for i, f := range folders {
		folderIDs[i] = f.ID
	}
	listIDs := make([]string, len(lists))
	for i, l := range lists {
		listIDs[i] = l.ID
	}
	return s.repo.MoveBranchToSpace(
		folderIDs, listIDs, folderID, spaceID, s.repo.LastRankIn("task_folders", spaceID))
}

// MoveListToSpace takes one list to another space of the same organization.
//
// It carries its channel with it, explicitly. A list with no binding of its own
// shows whatever its space says, so moving it from a bound space into an
// unbound one — or into one bound to a different client — would change who can
// read that work as a side effect of tidying up. Writing the inherited channel
// onto the list at the moment of the move keeps the answer to "who sees this"
// exactly as it was, and makes it visible in the dialog rather than implied.
func (s *TaskService) MoveListToSpace(listID, spaceID string) error {
	l, err := s.repo.FindList(listID)
	if err != nil {
		return err
	}
	if err := s.mismaOrganizacion(l.SpaceID, spaceID); err != nil {
		return err
	}
	var fijar *string
	if l.ProjectID == nil {
		if origen, err := s.repo.FindSpace(l.SpaceID); err == nil && origen.ProjectID != nil {
			heredado := *origen.ProjectID
			fijar = &heredado
		}
	}
	return s.repo.MoveListToSpace(listID, spaceID, fijar, s.repo.LastRankIn("task_lists", spaceID))
}

func (s *TaskService) mismaOrganizacion(origenSpaceID, destinoSpaceID string) error {
	origen, err := s.repo.FindSpace(origenSpaceID)
	if err != nil {
		return err
	}
	destino, err := s.repo.FindSpace(destinoSpaceID)
	if err != nil {
		return err
	}
	if origen.OrgID != destino.OrgID {
		return ErrDifferentOrganization
	}
	return nil
}
