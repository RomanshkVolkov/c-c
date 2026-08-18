package repository

import (
	"errors"
	"strconv"
	"strings"
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
	// ErrListInUseByChannel guards the list a report project's items land in.
	// Deleting it used to be a plain cascade; once reports live on the board that
	// same cascade would take a tenant's whole history with it, and the tenant
	// would start getting 404s on urls it has stored.
	ErrListInUseByChannel = errors.New("a report project delivers into this list")
	// ErrChannelOtherOrg: binding to a channel of another organization would be a
	// way to push work onto a tenant nobody here is supposed to reach.
	ErrChannelOtherOrg = errors.New("that channel belongs to another organization")
	// ErrListHoldsChannelWork: there is a client's ticket in here.
	ErrListHoldsChannelWork = errors.New("this list holds work that belongs to a client's channel")
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
	// Checked here rather than in each caller: DeleteList and DeleteSpace both
	// come through, and a guard that only covers one of two doors isn't a guard.
	var claimed int64
	if err := tx.Model(&domain.ReportProject{}).
		Where("list_id IN ?", listIDs).Count(&claimed).Error; err != nil {
		return err
	}
	if claimed > 0 {
		return ErrListInUseByChannel
	}

	// A channel item in here is a client's ticket, with a folio they may have
	// quoted and a url they may have stored. Deleting the list around it is not
	// an intent anyone can have expressed by clicking "delete list", so it is
	// refused rather than interpreted.
	var channelItems int64
	if err := tx.Model(&domain.Item{}).
		Where("list_id IN ? AND project_id <> ''", listIDs).Count(&channelItems).Error; err != nil {
		return err
	}
	if channelItems > 0 {
		return ErrListHoldsChannelWork
	}

	var itemIDs []string
	tx.Model(&domain.Item{}).Where("list_id IN ?", listIDs).Pluck("id", &itemIDs)
	if len(itemIDs) > 0 {
		// Links carry no content of their own, so they go for real. Two statements
		// rather than a loop: the assignee table was renamed with the merge and
		// its column moved with it, so they no longer share one condition.
		if err := tx.Where("task_id IN ?", itemIDs).Delete(&domain.TaskTagLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("item_id IN ?", itemIDs).Delete(&domain.ItemAssignee{}).Error; err != nil {
			return err
		}
		// The work itself is only hidden. Deleting a list used to destroy every
		// task in it outright — no undo, no trace, and no way to tell afterwards
		// whether anything had been in there. Soft-deleting costs nothing and
		// makes the mistake survivable.
		for _, m := range []any{&domain.ItemComment{}, &domain.ItemAttachment{}} {
			if err := tx.Where("item_id IN ?", itemIDs).Delete(m).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("id IN ?", itemIDs).Delete(&domain.Item{}).Error; err != nil {
			return err
		}
	}
	return tx.Where("id IN ?", listIDs).Delete(&domain.TaskList{}).Error
}

// Tree assembles the navigator for the given orgs in a handful of queries
// rather than one per node.
// Tree lists spaces the caller may see. `orgID` narrows it to a single
// organization (what the app's org switcher asks for); empty means every org the
// caller belongs to. A superadmin sees all orgs, so without the narrowing they
// would get every space in the platform in one list.
func (r *TaskRepository) Tree(orgIDs []string, superadmin bool, orgID string) ([]domain.SpaceTree, error) {
	var spaces []domain.TaskSpace
	q := r.db.Order("rank ASC")
	if !superadmin {
		if len(orgIDs) == 0 {
			return []domain.SpaceTree{}, nil
		}
		q = q.Where("org_id IN ?", orgIDs)
	}
	if orgID != "" {
		q = q.Where("org_id = ?", orgID)
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
	r.db.Model(&domain.Item{}).
		Select("list_id, COUNT(*) AS n").
		Where("archived_at IS NULL").
		Group("list_id").Scan(&counts)
	countBy := make(map[string]int64, len(counts))
	for _, c := range counts {
		countBy[c.ListID] = c.N
	}

	// Space bindings, so a list can inherit one without a query per list.
	spaceProject := make(map[string]string, len(spaces))
	for _, sp := range spaces {
		if sp.ProjectID != nil {
			spaceProject[sp.ID] = *sp.ProjectID
		}
	}

	summary := func(l domain.TaskList) domain.ListSummary {
		// The channel a list belongs to: its own, or the one it inherits. Resolved
		// here so the navigator can mark which lists a client can see into —
		// invisible is exactly what that must not be.
		channel := ""
		if l.ProjectID != nil {
			channel = *l.ProjectID
		} else if sp := spaceProject[l.SpaceID]; sp != "" {
			channel = sp
		}
		return domain.ListSummary{ID: l.ID, Name: l.Name, ProjectID: channel, TaskCount: countBy[l.ID]}
	}

	out := make([]domain.SpaceTree, 0, len(spaces))
	for _, s := range spaces {
		tree := domain.SpaceTree{
			ID: s.ID, OrgID: s.OrgID, Name: s.Name, Color: s.Color, ProjectID: spaceProject[s.ID],
			Folders: []domain.FolderTree{}, Lists: []domain.ListSummary{},
		}
		// Recursive since folders can hold folders. `folders` is already in rank
		// order, so each level comes out ordered without sorting again.
		var hijos func(parent *string) []domain.FolderTree
		hijos = func(parent *string) []domain.FolderTree {
			out := []domain.FolderTree{}
			for _, f := range folders {
				if f.SpaceID != s.ID || !mismoPadre(f.ParentFolderID, parent) {
					continue
				}
				id := f.ID
				ft := domain.FolderTree{
					ID: f.ID, Name: f.Name,
					Folders: hijos(&id),
					Lists:   []domain.ListSummary{},
				}
				for _, l := range lists {
					if l.FolderID != nil && *l.FolderID == f.ID {
						ft.Lists = append(ft.Lists, summary(l))
					}
				}
				out = append(out, ft)
			}
			return out
		}
		tree.Folders = hijos(nil)
		for _, l := range lists {
			if l.SpaceID == s.ID && l.FolderID == nil {
				tree.Lists = append(tree.Lists, summary(l))
			}
		}
		out = append(out, tree)
	}
	return out, nil
}

// mismoPadre compares two optional parents, where nil means "under the space".
func mismoPadre(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
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

// MoveSpace only touches the rank: reparenting a space isn't a thing, it
// belongs to an organization.
func (r *TaskRepository) MoveSpace(id, newRank string) error {
	return r.db.Model(&domain.TaskSpace{}).Where("id = ?", id).Update("rank", newRank).Error
}

// MoveFolder reorders a folder and, since folders can now nest, optionally puts
// it inside another. A folder never leaves its space: crossing spaces is what
// "move to another space" is for, and doing it by accident with a drag would
// carry one client's work into another's.
func (r *TaskRepository) MoveFolder(id string, parentID *string, newRank string) error {
	return r.db.Model(&domain.TaskFolder{}).Where("id = ?", id).
		Updates(map[string]any{"parent_folder_id": parentID, "rank": newRank}).Error
}

// FolderParents maps every folder of a space to its parent, which is what a
// cycle check needs and the only thing it needs.
func (r *TaskRepository) FolderParents(spaceID string) (map[string]*string, error) {
	var rows []domain.TaskFolder
	if err := r.db.Select("id", "parent_folder_id").
		Where("space_id = ?", spaceID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]*string, len(rows))
	for _, f := range rows {
		out[f.ID] = f.ParentFolderID
	}
	return out, nil
}

// Siblings returns the ordered ids of a set, so "move up/down" can resolve the
// neighbours without the client tracking ranks.
func (r *TaskRepository) Siblings(table, scopeCol, scopeID string) []string {
	var ids []string
	q := r.db.Table(table).Order("rank ASC")
	if scopeCol != "" {
		q = q.Where(scopeCol+" = ?", scopeID)
	}
	q.Pluck("id", &ids)
	return ids
}

// RankOf reads one row's rank, used to compute a midpoint against a neighbour.
func (r *TaskRepository) RankOf(table, id string) string {
	var v string
	r.db.Table(table).Where("id = ?", id).Pluck("rank", &v)
	return v
}

// ─── Statuses ─────────────────────────────────────────────────────────────────
//
// There is no table any more. A board's columns are a rendering of the shared
// state machine, so they are computed rather than stored — which is why the
// endpoints that used to create, rename and delete them now answer 410 instead
// of pretending.
//
// What those rows really carried was their `kind`, and that survives: the four
// states map onto open / active / done exactly as before.

func (r *TaskRepository) Statuses(listID string) ([]domain.TaskStatus, error) {
	return domain.BoardStatuses(listID), nil
}

// FindStatus resolves a synthetic column id back to the column it names.
func (r *TaskRepository) FindStatus(id string) (*domain.TaskStatus, error) {
	status, ok := domain.SplitSyntheticStatusID(id)
	if !ok {
		return nil, ErrStatusNotFound
	}
	listID := ""
	if i := strings.LastIndex(id, "/"); i >= 0 {
		listID = id[:i]
	}
	st := domain.BoardStatusFor(listID, status)
	return &st, nil
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

// CreateTask assigns the next per-space folio and appends to its column.
func (r *TaskRepository) CreateTask(t *domain.Task, spaceID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		// Two numbering scopes, and which one applies is the same question as who
		// can see the item. A client-visible one takes the next folio of their
		// project — that number becomes its public name — and an internal one is
		// numbered within its space.
		//
		// Unscoped either way: a number handed out once is spent, and a
		// soft-deleted row still owns its own.
		var maxSeq int
		scope := tx.Unscoped()
		if t.ProjectID != "" {
			scope.Raw(`SELECT COALESCE(MAX(seq),0) FROM items WHERE project_id = ?`,
				t.ProjectID).Scan(&maxSeq)
		} else {
			scope.Raw(`SELECT COALESCE(MAX(seq),0) FROM items WHERE space_id = ? AND project_id = ''`,
				spaceID).Scan(&maxSeq)
		}
		t.Seq = maxSeq + 1
		t.SpaceID = spaceID

		var last string
		// Ranked against everything the board will show it beside, channel items
		// included — a rank computed over a different set than the one being
		// rendered puts the card in the wrong place.
		tx.Model(&domain.Item{}).Where("list_id = ? AND status = ?", t.ListID, t.Status).
			Order("rank DESC").Limit(1).Pluck("rank", &last)
		t.Rank = rank.Between(last, "")

		return tx.Create(t).Error
	})
}

// FindTaskByIdempotencyKey returns the task a previous attempt already created,
// or nil when there is none. Scoped to the list so the same key can be reused
// elsewhere.
func (r *TaskRepository) FindTaskByIdempotencyKey(listID, key string) (*domain.Task, error) {
	var t domain.Task
	err := r.db.Where("list_id = ? AND idempotency_key = ?", listID, key).First(&t).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// FindTask resolves a card by its id, or by the folio a client's ticket is
// known as — "portento-89".
//
// The folio exists to be quoted: it is what gets pasted into a chat message, an
// email, or an agent's prompt. Until now only cac itself could turn one back
// into a row, and everyone else had to search for it first, which makes a name
// that names nothing.
//
// Every read and write of a single card comes through here, so accepting the
// folio once covers the API and the MCP tools together instead of each endpoint
// growing its own parsing.
func (r *TaskRepository) FindTask(id string) (*domain.Task, error) {
	var t domain.Task
	err := r.db.First(&t, "id = ?", id).Error
	if err == nil {
		return &t, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if found, ok := r.findByFolio(id); ok {
		return found, nil
	}
	return nil, ErrTaskNotFound
}

// findByFolio turns "portento-89" into the item it names.
//
// Split on the *last* hyphen, not the first: slugs contain them
// ("tds-geolocation-12"), and cutting at the front would look for a project
// called "tds" and a sequence of "geolocation-12".
//
// Only channel items have a folio. An internal card's seq counts within its
// space, so the same digits belong to a different thing — resolving those here
// would hand back somebody else's card under the client's name.
func (r *TaskRepository) findByFolio(ref string) (*domain.Task, bool) {
	cut := strings.LastIndex(ref, "-")
	if cut <= 0 || cut == len(ref)-1 {
		return nil, false
	}
	slug, seqText := ref[:cut], ref[cut+1:]
	seq, err := strconv.Atoi(seqText)
	if err != nil || seq <= 0 {
		return nil, false
	}

	var t domain.Task
	err = r.db.Raw(`
		SELECT i.* FROM items i
		JOIN report_projects p ON p.id = i.project_id
		WHERE p.slug = ? AND i.seq = ? AND i.deleted_at IS NULL
	`, slug, seq).Scan(&t).Error
	if err != nil || t.ID == "" {
		return nil, false
	}
	return &t, true
}

func (r *TaskRepository) UpdateTask(id string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	return r.db.Model(&domain.Task{}).Where("id = ?", id).Updates(fields).Error
}

func (r *TaskRepository) MoveTask(id string, status domain.ReportStatus, newRank string, resolvedAt *time.Time) error {
	fields := map[string]any{"status": status, "rank": newRank, "resolved_at": resolvedAt}
	return r.db.Model(&domain.Item{}).Where("id = ?", id).Updates(fields).Error
}

func (r *TaskRepository) DeleteTask(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		// Tag links and assignees are pure links, so they go for real — each with
		// its own column since the assignee table moved.
		if err := tx.Where("task_id = ?", id).Delete(&domain.TaskTagLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("item_id = ?", id).Delete(&domain.ItemAssignee{}).Error; err != nil {
			return err
		}
		// What somebody wrote is only hidden — see deleteListsCascade.
		for _, m := range []any{&domain.ItemComment{}, &domain.ItemAttachment{}} {
			if err := tx.Where("item_id = ?", id).Delete(m).Error; err != nil {
				return err
			}
		}
		return tx.Delete(&domain.Item{}, "id = ?", id).Error
	})
}

// ListOpen returns unfinished tasks across every list in the given orgs, worst
// priority and soonest due date first.
//
// One query, joined rather than walked: the board is per-list, and the only
// other way to answer "what is pending" would be to fetch every list's board
// and add them up — which is a request per list on every dashboard load.
//
// "Unfinished" is read off the column's `kind`, never its name, so a team that
// renames "Done" to "Shipped" doesn't silently start seeing finished work here.
// Subtasks are left out for the same reason the board leaves them out: they're
// part of their parent's breakdown, and listing both double-counts the work.
func (r *TaskRepository) ListOpen(orgIDs []string, superadmin bool, orgID string, limit int) ([]domain.OpenTask, error) {
	if !superadmin && len(orgIDs) == 0 {
		return []domain.OpenTask{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	// The column names are rendered from the state now, so the SQL only has to
	// know which states are unfinished. Channel items stay out: they are served
	// by the report path and are somebody's client-facing ticket, not a line on
	// our dashboard.
	q := r.db.Table("items t").
		Select(`t.id, t.seq, t.title, t.priority, t.due_at, t.updated_at, t.status,
			l.id AS list_id, l.name AS list_name,
			sp.id AS space_id, sp.name AS space_name`).
		Joins("JOIN task_lists l ON l.id = t.list_id").
		Joins("JOIN task_spaces sp ON sp.id = l.space_id").
		Where("t.archived_at IS NULL AND t.parent_id IS NULL AND t.deleted_at IS NULL").
		Where("t.project_id = ''").
		Where("t.status NOT IN ('resolved','closed')")

	if !superadmin {
		q = q.Where("t.org_id IN ?", orgIDs)
	}
	if orgID != "" {
		q = q.Where("t.org_id = ?", orgID)
	}

	// Priority is stored as its name, so sorting has to spell out the order —
	// alphabetically 'urgent' would come last. NULLS LAST only restates what
	// Postgres already does for ASC, but the intent is worth writing down: a
	// task with no due date belongs after the dated ones, because no date is
	// not the same as due right now.
	out := []domain.OpenTask{}
	err := q.Order(`CASE t.priority
			WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2
			WHEN 'low' THEN 3 ELSE 4 END`).
		Order("t.due_at ASC NULLS LAST").
		Order("t.updated_at DESC").
		Limit(limit).
		Scan(&out).Error
	if err != nil {
		return nil, err
	}
	// Spelt the way an installed app expects to read them.
	for i := range out {
		st := domain.BoardStatusFor(out[i].ListID, out[i].Status)
		out[i].StatusName, out[i].StatusKind = st.Name, st.Kind
		out[i].Priority = out[i].Priority.TaskWire()
	}
	return out, nil
}

// Board returns every card in a list along with its tags and assignees, using
// three queries instead of N+1 per card.
func (r *TaskRepository) Board(listID string) ([]domain.TaskCard, error) {
	var tasks []domain.Task
	// Subtasks belong to their parent's breakdown, not to the column: showing
	// both would double-count the work on screen.
	//
	// A client's report is a card like any other. It was held back while the
	// report side still read its own tables — a card dragged here would have
	// changed one copy and not the other — and that stopped being true when
	// reports moved into this table.
	//
	// A withdrawn item is excluded, because it is not the client's work any more;
	// it is ours, and it shows up as an ordinary internal card.
	if err := r.db.Where("list_id = ? AND archived_at IS NULL AND parent_id IS NULL", listID).
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
	r.db.Table("item_assignees a").
		Select("a.item_id AS task_id, u.id, u.username").
		Joins("JOIN users u ON u.id = a.user_id").
		Where("a.item_id IN ?", ids).Scan(&assigneeRows)

	type countRow struct {
		TaskID string
		N      int64
	}
	var comments, attachments []countRow
	// The error is checked. It wasn't, and when the column behind these queries
	// was renamed every card quietly came back saying it had no comments — a
	// wrong answer served with a 200, which is the kind this codebase keeps
	// having to learn to refuse.
	if err := r.db.Model(&domain.ItemComment{}).Select("item_id AS task_id, COUNT(*) AS n").
		Where("item_id IN ?", ids).Group("item_id").Scan(&comments).Error; err != nil {
		return nil, err
	}
	if err := r.db.Model(&domain.ItemAttachment{}).Select("item_id AS task_id, COUNT(*) AS n").
		Where("item_id IN ?", ids).Group("item_id").Scan(&attachments).Error; err != nil {
		return nil, err
	}

	// Subtask progress, resolved through the column's `kind` so it survives
	// someone renaming "Done".
	type subRow struct {
		ParentID string
		Total    int64
		Done     int64
	}
	var subs []subRow
	// "Done" is still not a name: it is the set of states that mean finished, and
	// closed counts — a subtask nobody is going to do is not outstanding work.
	r.db.Table("items t").
		Select(`t.parent_id, COUNT(*) AS total,
			COUNT(*) FILTER (WHERE t.status IN ('resolved','closed')) AS done`).
		Where("t.parent_id IN ? AND t.archived_at IS NULL AND t.deleted_at IS NULL", ids).
		Group("t.parent_id").Scan(&subs)
	subTotal := map[string]int64{}
	subDone := map[string]int64{}
	for _, s := range subs {
		subTotal[s.ParentID] = s.Total
		subDone[s.ParentID] = s.Done
	}

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
			ID: t.ID, Seq: t.Seq, Title: t.Title, Priority: t.Priority.TaskWire(),
			StatusID: domain.SyntheticStatusID(t.ListID, t.Status), DueAt: t.DueAt,
			HasDescription:  t.Description != "",
			SubtaskCount:    subTotal[t.ID],
			SubtaskDone:     subDone[t.ID],
			CommentCount:    commentsBy[t.ID],
			AttachmentCount: attachmentsBy[t.ID],
			Tags:            orEmptyTags(tagsBy[t.ID]),
			Assignees:       orEmptyUsers(asgBy[t.ID]),
			UpdatedAt:       t.UpdatedAt,
			Category:        string(t.Category),
			Area:            t.Area,
			CreatedAt:       t.CreatedAt,
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

// Subtasks returns a task's children as cards, ordered like the board.
func (r *TaskRepository) Subtasks(parentID string) ([]domain.TaskCard, error) {
	var tasks []domain.Task
	if err := r.db.Where("parent_id = ? AND archived_at IS NULL", parentID).
		Order("rank ASC").Find(&tasks).Error; err != nil {
		return nil, err
	}
	out := make([]domain.TaskCard, len(tasks))
	for i, t := range tasks {
		out[i] = domain.TaskCard{
			ID: t.ID, Seq: t.Seq, Title: t.Title, Priority: t.Priority.TaskWire(),
			StatusID: domain.SyntheticStatusID(t.ListID, t.Status), DueAt: t.DueAt,
			HasDescription: t.Description != "",
			Tags:           []domain.TaskTag{},
			Assignees:      []domain.UserSummary{},
			UpdatedAt:      t.UpdatedAt,
		}
	}
	return out, nil
}

// ─── Tags / assignees ─────────────────────────────────────────────────────────

// ListTags mirrors Tree's scoping: tags belong to an org, so the picker must not
// offer another org's labels.
func (r *TaskRepository) ListTags(orgIDs []string, superadmin bool, orgID string) ([]domain.TaskTag, error) {
	var out []domain.TaskTag
	q := r.db.Order("name ASC")
	if !superadmin {
		if len(orgIDs) == 0 {
			return []domain.TaskTag{}, nil
		}
		q = q.Where("org_id IN ?", orgIDs)
	}
	if orgID != "" {
		q = q.Where("org_id = ?", orgID)
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

// SetAssignees replaces the whole set. The first id given is the primary — the
// one a tenant sees, since their contract names a single person.
func (r *TaskRepository) SetAssignees(taskID string, userIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("item_id = ?", taskID).Delete(&domain.ItemAssignee{}).Error; err != nil {
			return err
		}
		if len(userIDs) == 0 {
			return nil
		}
		rows := make([]domain.ItemAssignee, len(userIDs))
		for i, id := range userIDs {
			rows[i] = domain.ItemAssignee{ItemID: taskID, UserID: id, Primary: i == 0}
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
		Joins("JOIN item_assignees a ON a.user_id = u.id").
		Where("a.item_id = ?", taskID).Order("u.username ASC").Scan(&out).Error
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

// Comments reads a card's thread for the board.
//
// The author comes from the shared reader, not from a join of its own. This
// used to resolve the name with `LEFT JOIN users` alone, which answers only for
// people who have a cac account — so a reply from the client, or from their
// app, arrived with an empty name and the client's half of the conversation
// rendered anonymous. The report facade never had that bug because it goes
// through tagAuthor, and tagAuthor's whole reason for existing is that one
// place must decide this. This is now that one place for both.
// ProjectSlug names the channel an item arrived through, for its folio.
//
// Empty when there is no channel or it has since been removed — a card that
// can't be named is still a card, and refusing to open it over a missing slug
// would be worse than showing it without one.
func (r *TaskRepository) ProjectSlug(projectID string) string {
	if projectID == "" {
		return ""
	}
	var slug string
	r.db.Raw(`SELECT slug FROM report_projects WHERE id = ?`, projectID).Scan(&slug)
	return slug
}

func (r *TaskRepository) Comments(taskID string) ([]domain.TaskCommentResponse, error) {
	// Internal lines belong here — this is the team's own board, and the
	// visibility of each one travels with it so the thread can say who else is
	// reading. Withdrawn ones do not: retracting a comment on a card removes it,
	// which is what the board has always done.
	rows, err := listItemComments(r.db, taskID, true, false)
	if err != nil {
		return nil, err
	}

	out := make([]domain.TaskCommentResponse, len(rows))
	for i, row := range rows {
		att, err := r.attachmentsOfComment(row.ID)
		if err != nil {
			return nil, err
		}
		userID := ""
		if row.AuthorUserID != nil {
			userID = *row.AuthorUserID
		}
		out[i] = domain.TaskCommentResponse{
			ID:           row.ID,
			Author:       row.Author,
			AuthorUserID: userID,
			AuthorName:   row.AuthorName,
			Visibility:   domain.ItemVisibility(row.Visibility),
			Kind:         row.Kind,
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
	q := r.db.Where("item_id = ?", taskID)
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

