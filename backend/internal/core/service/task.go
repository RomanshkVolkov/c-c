package service

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/rank"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var ErrNoStatuses = errors.New("list has no status columns")

type TaskService struct {
	repo *repository.TaskRepository
}

func NewTaskService(repo *repository.TaskRepository) *TaskService {
	return &TaskService{repo: repo}
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

func (s *TaskService) Tree(orgIDs []string, superadmin bool) ([]domain.SpaceTree, error) {
	return s.repo.Tree(orgIDs, superadmin)
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
func (s *TaskService) DeleteFolder(id string) error       { return s.repo.DeleteFolder(id) }
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
func (s *TaskService) DeleteList(id string) error                   { return s.repo.DeleteList(id) }

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
		ListID:      list.ID,
		StatusID:    statusID,
		OrgID:       orgID,
		Title:       req.Title,
		Priority:    priority,
		CreatedByID: userID,
	}
	t.ID = uuid.NewString()
	if err := s.repo.CreateTask(t, list.SpaceID); err != nil {
		return nil, err
	}
	return t, nil
}

func (s *TaskService) FindTask(id string) (*domain.Task, error) { return s.repo.FindTask(id) }

func (s *TaskService) UpdateTask(id string, req domain.UpdateTaskRequest) error {
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
	return s.repo.MoveTask(id, req.StatusID, newRank, completedAt)
}

func (s *TaskService) DeleteTask(id string) error { return s.repo.DeleteTask(id) }

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
	return &domain.TaskDetail{
		Task: *t, ListName: list.Name, SpaceName: space.Name, Status: *status,
		Tags: tags, Assignees: assignees, Comments: comments, Attachments: attachments,
	}, nil
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

func (s *TaskService) ListTags(orgIDs []string, superadmin bool) ([]domain.TaskTag, error) {
	return s.repo.ListTags(orgIDs, superadmin)
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
	return c, nil
}

func (s *TaskService) FindComment(id string) (*domain.TaskComment, error) {
	return s.repo.FindComment(id)
}

func (s *TaskService) EditComment(id, body string) error { return s.repo.UpdateComment(id, body) }
func (s *TaskService) DeleteComment(id string) error     { return s.repo.DeleteComment(id) }

func (s *TaskService) AddAttachment(a *domain.TaskAttachment) error {
	a.ID = uuid.NewString()
	return s.repo.CreateAttachment(a)
}

func (s *TaskService) FindAttachment(id string) (*domain.TaskAttachment, error) {
	return s.repo.FindAttachment(id)
}

func (s *TaskService) DeleteAttachment(id string) error { return s.repo.DeleteAttachment(id) }
