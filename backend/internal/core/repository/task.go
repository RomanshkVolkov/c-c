package repository

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/rank"
	"gorm.io/gorm"
)

var (
	ErrSpaceNotFound  = errors.New("space not found")
	ErrListNotFound   = errors.New("list not found")
	ErrTaskNotFound   = errors.New("task not found")
	ErrStatusNotFound = errors.New("status not found")
	ErrLastStatus     = errors.New("a list needs at least one status column")
)

type TaskRepository struct {
	db *gorm.DB
}

func NewTaskRepository(db *gorm.DB) *TaskRepository {
	return &TaskRepository{db: db}
}

// ─── Ranking helpers ──────────────────────────────────────────────────────────

// nextRank returns a rank that appends to the end of a sibling set.
func (r *TaskRepository) nextRank(table, where string, args ...any) string {
	var last string
	r.db.Table(table).Where(where, args...).Order("rank DESC").Limit(1).Pluck("rank", &last)
	return rank.Between(last, "")
}

// ─── Spaces ───────────────────────────────────────────────────────────────────

func (r *TaskRepository) CreateSpace(s *domain.TaskSpace) error {
	s.Rank = r.nextRank("task_spaces", "org_id = ?", s.OrgID)
	return r.db.Create(s).Error
}

func (r *TaskRepository) FindSpace(id string) (*domain.TaskSpace, error) {
	var s domain.TaskSpace
	if err := r.db.First(&s, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrSpaceNotFound
		}
		return nil, err
	}
	return &s, nil
}

func (r *TaskRepository) UpdateSpace(id, name, color string) error {
	return r.db.Model(&domain.TaskSpace{}).Where("id = ?", id).
		Updates(map[string]any{"name": name, "color": color}).Error
}

// DeleteSpace removes a space and everything under it in one transaction.
func (r *TaskRepository) DeleteSpace(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var listIDs []string
		tx.Model(&domain.TaskList{}).Where("space_id = ?", id).Pluck("id", &listIDs)
		if len(listIDs) > 0 {
			if err := deleteListsCascade(tx, listIDs); err != nil {
				return err
			}
		}
		if err := tx.Where("space_id = ?", id).Delete(&domain.TaskFolder{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.TaskSpace{}, "id = ?", id).Error
	})
}

func deleteListsCascade(tx *gorm.DB, listIDs []string) error {
	var taskIDs []string
	tx.Model(&domain.Task{}).Where("list_id IN ?", listIDs).Pluck("id", &taskIDs)
	if len(taskIDs) > 0 {
		for _, m := range []any{
			&domain.TaskTagLink{}, &domain.TaskAssignee{},
			&domain.TaskComment{}, &domain.TaskAttachment{},
		} {
			if err := tx.Where("task_id IN ?", taskIDs).Delete(m).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("id IN ?", taskIDs).Delete(&domain.Task{}).Error; err != nil {
			return err
		}
	}
	if err := tx.Where("list_id IN ?", listIDs).Delete(&domain.TaskStatus{}).Error; err != nil {
		return err
	}
	return tx.Where("id IN ?", listIDs).Delete(&domain.TaskList{}).Error
}

// Tree assembles the navigator for the given orgs in a handful of queries
// rather than one per node.
func (r *TaskRepository) Tree(orgIDs []string, superadmin bool) ([]domain.SpaceTree, error) {
	var spaces []domain.TaskSpace
	q := r.db.Order("rank ASC")
	if !superadmin {
		if len(orgIDs) == 0 {
			return []domain.SpaceTree{}, nil
		}
		q = q.Where("org_id IN ?", orgIDs)
	}
	if err := q.Find(&spaces).Error; err != nil {
		return nil, err
	}
	if len(spaces) == 0 {
		return []domain.SpaceTree{}, nil
	}

	spaceIDs := make([]string, len(spaces))
	for i, s := range spaces {
		spaceIDs[i] = s.ID
	}

	var folders []domain.TaskFolder
	if err := r.db.Where("space_id IN ?", spaceIDs).Order("rank ASC").Find(&folders).Error; err != nil {
		return nil, err
	}
	var lists []domain.TaskList
	if err := r.db.Where("space_id IN ?", spaceIDs).Order("rank ASC").Find(&lists).Error; err != nil {
		return nil, err
	}

	// Open task counts per list, in one grouped query.
	type countRow struct {
		ListID string
		N      int64
	}
	var counts []countRow
	r.db.Model(&domain.Task{}).
		Select("list_id, COUNT(*) AS n").
		Where("archived_at IS NULL").
		Group("list_id").Scan(&counts)
	countBy := make(map[string]int64, len(counts))
	for _, c := range counts {
		countBy[c.ListID] = c.N
	}

	summary := func(l domain.TaskList) domain.ListSummary {
		return domain.ListSummary{ID: l.ID, Name: l.Name, TaskCount: countBy[l.ID]}
	}

	out := make([]domain.SpaceTree, 0, len(spaces))
	for _, s := range spaces {
		tree := domain.SpaceTree{
			ID: s.ID, OrgID: s.OrgID, Name: s.Name, Color: s.Color,
			Folders: []domain.FolderTree{}, Lists: []domain.ListSummary{},
		}
		for _, f := range folders {
			if f.SpaceID != s.ID {
				continue
			}
			ft := domain.FolderTree{ID: f.ID, Name: f.Name, Lists: []domain.ListSummary{}}
			for _, l := range lists {
				if l.FolderID != nil && *l.FolderID == f.ID {
					ft.Lists = append(ft.Lists, summary(l))
				}
			}
			tree.Folders = append(tree.Folders, ft)
		}
		for _, l := range lists {
			if l.SpaceID == s.ID && l.FolderID == nil {
				tree.Lists = append(tree.Lists, summary(l))
			}
		}
		out = append(out, tree)
	}
	return out, nil
}

// ─── Folders / lists ──────────────────────────────────────────────────────────

func (r *TaskRepository) CreateFolder(f *domain.TaskFolder) error {
	f.Rank = r.nextRank("task_folders", "space_id = ?", f.SpaceID)
	return r.db.Create(f).Error
}

func (r *TaskRepository) RenameFolder(id, name string) error {
	return r.db.Model(&domain.TaskFolder{}).Where("id = ?", id).Update("name", name).Error
}

func (r *TaskRepository) FindFolder(id string) (*domain.TaskFolder, error) {
	var f domain.TaskFolder
	if err := r.db.First(&f, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &f, nil
}

// DeleteFolder removes the folder; its lists move up to the space so no work is
// silently destroyed.
func (r *TaskRepository) DeleteFolder(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&domain.TaskList{}).Where("folder_id = ?", id).
			Update("folder_id", nil).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.TaskFolder{}, "id = ?", id).Error
	})
}

func (r *TaskRepository) CreateList(l *domain.TaskList, statuses []domain.TaskStatus) error {
	l.Rank = r.nextRank("task_lists", "space_id = ?", l.SpaceID)
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(l).Error; err != nil {
			return err
		}
		for i := range statuses {
			statuses[i].ListID = l.ID
		}
		if len(statuses) > 0 {
			return tx.Create(&statuses).Error
		}
		return nil
	})
}

func (r *TaskRepository) FindList(id string) (*domain.TaskList, error) {
	var l domain.TaskList
	if err := r.db.First(&l, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrListNotFound
		}
		return nil, err
	}
	return &l, nil
}

func (r *TaskRepository) RenameList(id, name string) error {
	return r.db.Model(&domain.TaskList{}).Where("id = ?", id).Update("name", name).Error
}

func (r *TaskRepository) DeleteList(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error { return deleteListsCascade(tx, []string{id}) })
}

// MoveList reorders a list and optionally reparents it into a folder.
func (r *TaskRepository) MoveList(id string, folderID *string, newRank string) error {
	return r.db.Model(&domain.TaskList{}).Where("id = ?", id).
		Updates(map[string]any{"folder_id": folderID, "rank": newRank}).Error
}

// RankOf reads one row's rank, used to compute a midpoint against a neighbour.
func (r *TaskRepository) RankOf(table, id string) string {
	var v string
	r.db.Table(table).Where("id = ?", id).Pluck("rank", &v)
	return v
}

// ─── Statuses ─────────────────────────────────────────────────────────────────

func (r *TaskRepository) Statuses(listID string) ([]domain.TaskStatus, error) {
	var out []domain.TaskStatus
	err := r.db.Where("list_id = ?", listID).Order("rank ASC").Find(&out).Error
	return out, err
}

func (r *TaskRepository) CreateStatus(s *domain.TaskStatus) error {
	s.Rank = r.nextRank("task_statuses", "list_id = ?", s.ListID)
	return r.db.Create(s).Error
}

func (r *TaskRepository) FindStatus(id string) (*domain.TaskStatus, error) {
	var s domain.TaskStatus
	if err := r.db.First(&s, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrStatusNotFound
		}
		return nil, err
	}
	return &s, nil
}

func (r *TaskRepository) UpdateStatus(id string, fields map[string]any) error {
	return r.db.Model(&domain.TaskStatus{}).Where("id = ?", id).Updates(fields).Error
}

// DeleteStatus refuses to strand tasks: the caller must pass a column to move
// them into, and a list can never be left without columns.
func (r *TaskRepository) DeleteStatus(id, moveToID string) error {
	st, err := r.FindStatus(id)
	if err != nil {
		return err
	}
	var n int64
	r.db.Model(&domain.TaskStatus{}).Where("list_id = ?", st.ListID).Count(&n)
	if n <= 1 {
		return ErrLastStatus
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		if moveToID == "" {
			return errors.New("a target column is required to absorb the tasks")
		}
		if err := tx.Model(&domain.Task{}).Where("status_id = ?", id).
			Update("status_id", moveToID).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.TaskStatus{}, "id = ?", id).Error
	})
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

// CreateTask assigns the next per-space folio and appends to its column.
func (r *TaskRepository) CreateTask(t *domain.Task, spaceID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var maxSeq int
		tx.Raw(`SELECT COALESCE(MAX(t.seq),0) FROM tasks t
		        JOIN task_lists l ON l.id = t.list_id
		        WHERE l.space_id = ?`, spaceID).Scan(&maxSeq)
		t.Seq = maxSeq + 1

		var last string
		tx.Model(&domain.Task{}).Where("status_id = ?", t.StatusID).
			Order("rank DESC").Limit(1).Pluck("rank", &last)
		t.Rank = rank.Between(last, "")

		return tx.Create(t).Error
	})
}

func (r *TaskRepository) FindTask(id string) (*domain.Task, error) {
	var t domain.Task
	if err := r.db.First(&t, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrTaskNotFound
		}
		return nil, err
	}
	return &t, nil
}

func (r *TaskRepository) UpdateTask(id string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	return r.db.Model(&domain.Task{}).Where("id = ?", id).Updates(fields).Error
}

func (r *TaskRepository) MoveTask(id, statusID, newRank string, completedAt *time.Time) error {
	fields := map[string]any{"status_id": statusID, "rank": newRank, "completed_at": completedAt}
	return r.db.Model(&domain.Task{}).Where("id = ?", id).Updates(fields).Error
}

func (r *TaskRepository) DeleteTask(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, m := range []any{
			&domain.TaskTagLink{}, &domain.TaskAssignee{},
			&domain.TaskComment{}, &domain.TaskAttachment{},
		} {
			if err := tx.Where("task_id = ?", id).Delete(m).Error; err != nil {
				return err
			}
		}
		return tx.Delete(&domain.Task{}, "id = ?", id).Error
	})
}

// Board returns every card in a list along with its tags and assignees, using
// three queries instead of N+1 per card.
func (r *TaskRepository) Board(listID string) ([]domain.TaskCard, error) {
	var tasks []domain.Task
	if err := r.db.Where("list_id = ? AND archived_at IS NULL", listID).
		Order("rank ASC").Find(&tasks).Error; err != nil {
		return nil, err
	}
	if len(tasks) == 0 {
		return []domain.TaskCard{}, nil
	}
	ids := make([]string, len(tasks))
	for i, t := range tasks {
		ids[i] = t.ID
	}

	type tagRow struct {
		TaskID string
		domain.TaskTag
	}
	var tagRows []tagRow
	r.db.Table("task_tag_links l").
		Select("l.task_id, t.*").
		Joins("JOIN task_tags t ON t.id = l.tag_id").
		Where("l.task_id IN ?", ids).Scan(&tagRows)

	type assigneeRow struct {
		TaskID   string
		ID       string
		Username string
	}
	var assigneeRows []assigneeRow
	r.db.Table("task_assignees a").
		Select("a.task_id, u.id, u.username").
		Joins("JOIN users u ON u.id = a.user_id").
		Where("a.task_id IN ?", ids).Scan(&assigneeRows)

	type countRow struct {
		TaskID string
		N      int64
	}
	var comments, attachments []countRow
	r.db.Model(&domain.TaskComment{}).Select("task_id, COUNT(*) AS n").
		Where("task_id IN ?", ids).Group("task_id").Scan(&comments)
	r.db.Model(&domain.TaskAttachment{}).Select("task_id, COUNT(*) AS n").
		Where("task_id IN ?", ids).Group("task_id").Scan(&attachments)

	tagsBy := map[string][]domain.TaskTag{}
	for _, t := range tagRows {
		tagsBy[t.TaskID] = append(tagsBy[t.TaskID], t.TaskTag)
	}
	asgBy := map[string][]domain.UserSummary{}
	for _, a := range assigneeRows {
		asgBy[a.TaskID] = append(asgBy[a.TaskID], domain.UserSummary{ID: a.ID, Username: a.Username})
	}
	countBy := func(rows []countRow) map[string]int64 {
		m := make(map[string]int64, len(rows))
		for _, r := range rows {
			m[r.TaskID] = r.N
		}
		return m
	}
	commentsBy, attachmentsBy := countBy(comments), countBy(attachments)

	cards := make([]domain.TaskCard, len(tasks))
	for i, t := range tasks {
		cards[i] = domain.TaskCard{
			ID: t.ID, Seq: t.Seq, Title: t.Title, Priority: t.Priority,
			StatusID: t.StatusID, DueAt: t.DueAt,
			HasDescription:  t.Description != "",
			CommentCount:    commentsBy[t.ID],
			AttachmentCount: attachmentsBy[t.ID],
			Tags:            orEmptyTags(tagsBy[t.ID]),
			Assignees:       orEmptyUsers(asgBy[t.ID]),
			UpdatedAt:       t.UpdatedAt,
		}
	}
	return cards, nil
}

func orEmptyTags(v []domain.TaskTag) []domain.TaskTag {
	if v == nil {
		return []domain.TaskTag{}
	}
	return v
}

func orEmptyUsers(v []domain.UserSummary) []domain.UserSummary {
	if v == nil {
		return []domain.UserSummary{}
	}
	return v
}

// ─── Tags / assignees ─────────────────────────────────────────────────────────

func (r *TaskRepository) ListTags(orgIDs []string, superadmin bool) ([]domain.TaskTag, error) {
	var out []domain.TaskTag
	q := r.db.Order("name ASC")
	if !superadmin {
		if len(orgIDs) == 0 {
			return []domain.TaskTag{}, nil
		}
		q = q.Where("org_id IN ?", orgIDs)
	}
	err := q.Find(&out).Error
	return out, err
}

func (r *TaskRepository) CreateTag(t *domain.TaskTag) error { return r.db.Create(t).Error }

func (r *TaskRepository) SetTags(taskID string, tagIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("task_id = ?", taskID).Delete(&domain.TaskTagLink{}).Error; err != nil {
			return err
		}
		if len(tagIDs) == 0 {
			return nil
		}
		links := make([]domain.TaskTagLink, len(tagIDs))
		for i, id := range tagIDs {
			links[i] = domain.TaskTagLink{TaskID: taskID, TagID: id}
		}
		return tx.Create(&links).Error
	})
}

func (r *TaskRepository) SetAssignees(taskID string, userIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("task_id = ?", taskID).Delete(&domain.TaskAssignee{}).Error; err != nil {
			return err
		}
		if len(userIDs) == 0 {
			return nil
		}
		rows := make([]domain.TaskAssignee, len(userIDs))
		for i, id := range userIDs {
			rows[i] = domain.TaskAssignee{TaskID: taskID, UserID: id}
		}
		return tx.Create(&rows).Error
	})
}

func (r *TaskRepository) TagsOf(taskID string) ([]domain.TaskTag, error) {
	var out []domain.TaskTag
	err := r.db.Table("task_tags t").
		Joins("JOIN task_tag_links l ON l.tag_id = t.id").
		Where("l.task_id = ?", taskID).Order("t.name ASC").Scan(&out).Error
	return orEmptyTags(out), err
}

func (r *TaskRepository) AssigneesOf(taskID string) ([]domain.UserSummary, error) {
	var out []domain.UserSummary
	err := r.db.Table("users u").
		Select("u.id, u.username").
		Joins("JOIN task_assignees a ON a.user_id = u.id").
		Where("a.task_id = ?", taskID).Order("u.username ASC").Scan(&out).Error
	return orEmptyUsers(out), err
}

// ─── Comments / attachments ───────────────────────────────────────────────────

func (r *TaskRepository) CreateComment(c *domain.TaskComment) error { return r.db.Create(c).Error }

func (r *TaskRepository) UpdateComment(id, body string) error {
	return r.db.Model(&domain.TaskComment{}).Where("id = ?", id).Update("body", body).Error
}

func (r *TaskRepository) FindComment(id string) (*domain.TaskComment, error) {
	var c domain.TaskComment
	if err := r.db.First(&c, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *TaskRepository) DeleteComment(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("comment_id = ?", id).Delete(&domain.TaskAttachment{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.TaskComment{}, "id = ?", id).Error
	})
}

func (r *TaskRepository) Comments(taskID string) ([]domain.TaskCommentResponse, error) {
	// Scan into a flat row first: GORM tries to resolve a slice field on the
	// destination struct as a relation and refuses the query otherwise.
	type commentRow struct {
		ID           string
		AuthorUserID string
		AuthorName   string
		Body         string
		CreatedAt    time.Time
		UpdatedAt    time.Time
	}
	var rows []commentRow
	err := r.db.Table("task_comments c").
		Select("c.id, c.author_user_id, COALESCE(u.username,'') AS author_name, c.body, c.created_at, c.updated_at").
		Joins("LEFT JOIN users u ON u.id = c.author_user_id").
		Where("c.task_id = ?", taskID).Order("c.created_at ASC").Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	out := make([]domain.TaskCommentResponse, len(rows))
	for i, row := range rows {
		att, err := r.attachmentsOfComment(row.ID)
		if err != nil {
			return nil, err
		}
		out[i] = domain.TaskCommentResponse{
			ID:           row.ID,
			AuthorUserID: row.AuthorUserID,
			AuthorName:   row.AuthorName,
			Body:         row.Body,
			Attachments:  att,
			CreatedAt:    row.CreatedAt,
			UpdatedAt:    row.UpdatedAt,
		}
	}
	return out, nil
}

func (r *TaskRepository) attachmentsOfComment(commentID string) ([]domain.TaskAttachment, error) {
	var att []domain.TaskAttachment
	if err := r.db.Where("comment_id = ?", commentID).Order("created_at ASC").Find(&att).Error; err != nil {
		return nil, err
	}
	if att == nil {
		att = []domain.TaskAttachment{}
	}
	return att, nil
}

func (r *TaskRepository) CreateAttachment(a *domain.TaskAttachment) error {
	return r.db.Create(a).Error
}

func (r *TaskRepository) Attachments(taskID string, commentID *string) ([]domain.TaskAttachment, error) {
	var out []domain.TaskAttachment
	q := r.db.Where("task_id = ?", taskID)
	if commentID == nil {
		q = q.Where("comment_id IS NULL")
	}
	err := q.Order("created_at ASC").Find(&out).Error
	if out == nil {
		out = []domain.TaskAttachment{}
	}
	return out, err
}

func (r *TaskRepository) FindAttachment(id string) (*domain.TaskAttachment, error) {
	var a domain.TaskAttachment
	if err := r.db.First(&a, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &a, nil
}

func (r *TaskRepository) DeleteAttachment(id string) error {
	return r.db.Delete(&domain.TaskAttachment{}, "id = ?", id).Error
}
