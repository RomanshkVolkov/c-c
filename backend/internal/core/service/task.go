package service

import (
	"errors"
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
)

type TaskService struct {
	repo *repository.TaskRepository
	// hub broadcasts board changes so every open console reflects them without
	// polling. Optional: a nil hub simply means no live updates.
	hub *events.Hub
}

func NewTaskService(repo *repository.TaskRepository, hub *events.Hub) *TaskService {
	return &TaskService{repo: repo, hub: hub}
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
		{"To do", "#7D8BA3", domain.StatusKindOpen},
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

func (s *TaskService) ListOpen(orgIDs []string, superadmin bool, orgID string, limit int) ([]domain.OpenTask, error) {
	return s.repo.ListOpen(orgIDs, superadmin, orgID, limit)
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

func (s *TaskService) CreateFolder(spaceID, name string) (*domain.TaskFolder, error) {
	f := &domain.TaskFolder{SpaceID: spaceID, Name: name}
	f.ID = uuid.NewString()
	if err := s.repo.CreateFolder(f); err != nil {
		return nil, err
	}
	return f, nil
}

func (s *TaskService) RenameFolder(id, name string) error { return s.repo.RenameFolder(id, name) }

// MoveFolder reorders a folder among its space's folders.
func (s *TaskService) MoveFolder(id string, req domain.MoveNodeRequest) error {
	return s.repo.MoveFolder(id, s.rankBetween("task_folders", req.AfterID, req.BeforeID))
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
func (s *TaskService) BindList(listID, projectID string) error {
	if err := s.repo.BindListToChannel(listID, projectID); err != nil {
		return err
	}
	if projectID == "" {
		return nil
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

func (s *TaskService) CreateStatus(listID string, req domain.CreateStatusRequest) (*domain.TaskStatus, error) {
	kind := req.Kind
	if kind == "" {
		kind = domain.StatusKindOpen
	}
	st := &domain.TaskStatus{ListID: listID, Name: req.Name, Color: req.Color, Kind: kind}
	st.ID = uuid.NewString()
	if err := s.repo.CreateStatus(st); err != nil {
		return nil, err
	}
	return st, nil
}

func (s *TaskService) FindStatus(id string) (*domain.TaskStatus, error) {
	return s.repo.FindStatus(id)
}

func (s *TaskService) UpdateStatus(id string, req domain.UpdateStatusRequest) error {
	fields := map[string]any{"name": req.Name}
	if req.Color != "" {
		fields["color"] = req.Color
	}
	if req.Kind != "" {
		fields["kind"] = req.Kind
	}
	return s.repo.UpdateStatus(id, fields)
}

func (s *TaskService) MoveStatus(id, afterID, beforeID string) error {
	return s.repo.UpdateStatus(id, map[string]any{
		"rank": s.rankBetween("task_statuses", afterID, beforeID),
	})
}

func (s *TaskService) DeleteStatus(id, moveToID string) error {
	return s.repo.DeleteStatus(id, moveToID)
}

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
func (s *TaskService) CreateTask(list *domain.TaskList, orgID, userID string, req domain.CreateTaskRequest) (*domain.Task, error) {
	// A retry with the same key must not produce a second card. Checked before
	// doing any work, and backed by a partial unique index for the case where two
	// retries land at once.
	if req.IdempotencyKey != "" {
		if existing, err := s.repo.FindTaskByIdempotencyKey(list.ID, req.IdempotencyKey); err == nil && existing != nil {
			return existing, nil
		}
	}

	statusID := req.StatusID
	if statusID == "" {
		statuses, err := s.repo.Statuses(list.ID)
		if err != nil {
			return nil, err
		}
		if len(statuses) == 0 {
			return nil, ErrNoStatuses
		}
		statusID = statuses[0].ID
	}
	priority := req.Priority
	if priority == "" {
		priority = domain.PriorityNone
	}

	t := &domain.Task{
		ListID:         list.ID,
		StatusID:       statusID,
		OrgID:          orgID,
		Title:          req.Title,
		Description:    req.Description,
		IdempotencyKey: req.IdempotencyKey,
		Priority:       priority,
		CreatedByID:    userID,
	}
	if req.ParentID != "" {
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
	s.publish("task:new", orgID, list.ID, t.ID)
	return t, nil
}

func (s *TaskService) FindTask(id string) (*domain.Task, error) { return s.repo.FindTask(id) }

func (s *TaskService) UpdateTask(id string, req domain.UpdateTaskRequest) error {
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
	if err := s.repo.UpdateTask(id, fields); err != nil {
		return err
	}
	if req.TagIDs != nil {
		if err := s.repo.SetTags(id, *req.TagIDs); err != nil {
			return err
		}
	}
	if req.AssigneeIDs != nil {
		if err := s.repo.SetAssignees(id, *req.AssigneeIDs); err != nil {
			return err
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
func (s *TaskService) MoveTask(id string, req domain.MoveTaskRequest) error {
	status, err := s.repo.FindStatus(req.StatusID)
	if err != nil {
		return err
	}
	task, err := s.repo.FindTask(id)
	if err != nil {
		return err
	}

	var completedAt *time.Time
	if status.Kind == domain.StatusKindDone {
		if task.CompletedAt != nil {
			completedAt = task.CompletedAt // already closed; keep the original date
		} else {
			now := time.Now()
			completedAt = &now
		}
	}

	newRank := s.rankBetween("tasks", req.AfterID, req.BeforeID)
	if err := s.repo.MoveTask(id, req.StatusID, newRank, completedAt); err != nil {
		return err
	}
	s.publish("task:move", task.OrgID, task.ListID, task.ID)
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

// Detail assembles everything the task drawer needs in one response.
func (s *TaskService) Detail(id string) (*domain.TaskDetail, error) {
	t, err := s.repo.FindTask(id)
	if err != nil {
		return nil, err
	}
	list, err := s.repo.FindList(t.ListID)
	if err != nil {
		return nil, err
	}
	space, err := s.repo.FindSpace(list.SpaceID)
	if err != nil {
		return nil, err
	}
	status, err := s.repo.FindStatus(t.StatusID)
	if err != nil {
		return nil, err
	}
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
		Task: *t, ListName: list.Name, SpaceName: space.Name, Status: *status,
		Tags: tags, Assignees: assignees, Comments: comments, Attachments: attachments,
		Subtasks: subtasks,
	}
	// When this task is a subtask, hand the drawer enough to link back up.
	if t.ParentID != nil {
		if p, err := s.repo.FindTask(*t.ParentID); err == nil {
			detail.Parent = &domain.TaskCard{ID: p.ID, Seq: p.Seq, Title: p.Title, StatusID: p.StatusID}
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

// ─── Comments / attachments ───────────────────────────────────────────────────

func (s *TaskService) AddComment(taskID, userID, body string) (*domain.TaskComment, error) {
	c := &domain.TaskComment{TaskID: taskID, AuthorUserID: userID, Body: body}
	c.ID = uuid.NewString()
	if err := s.repo.CreateComment(c); err != nil {
		return nil, err
	}
	if t, err := s.repo.FindTask(taskID); err == nil {
		s.publish("task:comment", t.OrgID, t.ListID, t.ID)
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
		before, taskID = c.Body, c.TaskID
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
		before, taskID = c.Body, c.TaskID
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
