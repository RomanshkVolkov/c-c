package repository

import (
	"fmt"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// Filling the unified `items` tables from the two they replace.
//
// This runs on every boot, and it runs in the dark: for the whole of this phase
// nothing reads what it writes. That is the point. The copy can be checked
// against production data for as long as it takes to trust it, and if it is
// wrong the answer is to fix it and deploy again — there is no cutover to undo,
// because there has not been one.
//
// It is written as an upsert guarded on updated_at rather than a one-shot import,
// which buys two things. It is idempotent, so a restart is free. And it is a
// *delta*: during a rolling deploy the pod still running the old code keeps
// writing to the old tables, and the next boot picks those rows up. That is what
// makes the eventual switch-over survivable rather than a held breath.
//
// Deliberately unlike backfillAttachmentRefs, which logs its failures and
// carries on. Here a half-finished copy would be worse than a crash: the tables
// would look populated, and a later phase would serve short lists with a 200 and
// no sign that anything was missing. So verification failure panics, the pod
// never becomes ready, and the deploy stops.

const itemBackfillName = "unify-items-v1"

// schemaBackfill records what has already been done, so a completed one-off step
// is skipped instead of re-derived. Delta steps look at it but keep running.
type schemaBackfill struct {
	Name        string `gorm:"primaryKey;type:varchar(120)"`
	CompletedAt *string
	Detail      string `gorm:"type:text"`
}

func (schemaBackfill) TableName() string { return "schema_backfills" }

// migrateItems copies reports and tasks into the unified tables.
//
// The advisory lock is what makes two pods starting at once safe: the second one
// waits, sees the work already done, and moves on. A unique-index race would
// mostly have been harmless, but "mostly" is not a thing to rely on during a
// deploy.
func migrateItems(db *gorm.DB) {
	if err := db.AutoMigrate(&schemaBackfill{}); err != nil {
		panic("items migration: cannot record progress: " + err.Error())
	}

	// A constant, arbitrary key — it only has to be the same in every pod.
	const lockKey = 0x17E4_9021
	if err := db.Exec(`SELECT pg_advisory_lock(?)`, lockKey).Error; err != nil {
		panic("items migration: cannot take the lock: " + err.Error())
	}
	defer db.Exec(`SELECT pg_advisory_unlock(?)`, lockKey)

	if err := ensureItemHelperIndexes(db); err != nil {
		panic("items migration: indexes: " + err.Error())
	}
	if err := checkNoIDCollisions(db); err != nil {
		panic("items migration: " + err.Error())
	}

	steps := []struct {
		what string
		run  func(*gorm.DB) error
	}{
		{"channels", backfillProjectLists},
		{"reports", copyReportsToItems},
		{"tasks", copyTasksToItems},
		{"report comments", copyReportCommentsToItems},
		{"task comments", copyTaskCommentsToItems},
		{"report images", copyReportImagesToItems},
		{"task attachments", copyTaskAttachmentsToItems},
		{"assignees", backfillAssignees},
	}
	for _, s := range steps {
		if err := s.run(db); err != nil {
			panic("items migration: copying " + s.what + ": " + err.Error())
		}
	}

	if err := verifyItemCounts(db); err != nil {
		// No mark, no readiness: whatever is wrong gets looked at before this
		// build serves a request.
		panic("items migration: " + err.Error())
	}

	// The unique constraints go on **after** the rows, not before: applied first
	// they would reject the very data they are meant to describe, and the copy
	// would die on an insert instead of reporting what it found.
	ensureItemUniqueIndexes(db)

	now := "now()"
	db.Exec(`INSERT INTO schema_backfills (name, completed_at, detail)
	         VALUES (?, `+now+`, ?)
	         ON CONFLICT (name) DO UPDATE SET completed_at = `+now+`, detail = excluded.detail`,
		itemBackfillName, "delta upsert; old tables still authoritative")
	lg.Info("items migration: up to date")
}

// ensureItemHelperIndexes creates the plain lookup indexes. Safe at any point:
// they describe nothing that data can violate.
func ensureItemHelperIndexes(db *gorm.DB) error {
	stmts := []string{
		// Reading a thread, and counting what the reporter hasn't seen.
		`CREATE INDEX IF NOT EXISTS idx_item_comments_thread
			ON item_comments (item_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_item_comments_public
			ON item_comments (item_id) WHERE deleted_at IS NULL AND visibility = 'public'`,
	}
	for _, s := range stmts {
		if err := db.Exec(s).Error; err != nil {
			return err
		}
	}
	return nil
}

// ensureItemUniqueIndexes applies the constraints that make numbering trustworthy
// going forward — and does not bring the service down over data that was already
// wrong before any of this existed.
//
// The seq-reuse bug shipped: a production database may well hold two reports of
// one project sharing a number. A unique index cannot be built over that. The
// choice here is to say so, loudly and specifically, and carry on — nothing reads
// these tables yet, so the missing constraint costs nothing today, whereas a
// crash loop would take the whole backend down without helping anyone repair the
// rows. Once the duplicates are resolved, the next boot creates the index.
func ensureItemUniqueIndexes(db *gorm.DB) {
	unique := []struct {
		name string
		stmt string
		hint string
	}{
		{
			"idx_items_idempotency",
			// The empty string is "no key supplied", and every item without one
			// carries it — so only rows that really have a key participate.
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_idempotency
				ON items (list_id, idempotency_key) WHERE idempotency_key <> ''`,
			"two items in one list share an idempotency key",
		},
		{
			// Numbering has two scopes with disjoint predicates, so a row is only
			// ever subject to one: per project for a channel item (that number is
			// its public folio) and per space for an internal one.
			//
			// These see soft-deleted rows on purpose — a number, once handed out,
			// is spent.
			"idx_items_seq_project",
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_seq_project
				ON items (project_id, seq) WHERE project_id <> ''`,
			"two reports of one project share a folio",
		},
		{
			"idx_items_seq_space",
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_seq_space
				ON items (space_id, seq) WHERE project_id = '' AND space_id <> ''`,
			"two items in one space share a number",
		},
	}
	for _, u := range unique {
		if err := db.Exec(u.stmt).Error; err != nil {
			lg.Error("items migration: cannot create " + u.name + " (" + u.hint +
				"); the data needs repairing before this constraint can exist: " + err.Error())
		}
	}
}

// checkNoIDCollisions is cheap paranoia with a catastrophic downside if skipped.
//
// Both sides mint UUIDs, so an overlap is not going to happen. But ids are
// carried over unchanged — that is what keeps saved links and the tenant's own
// records working — so if one ever did, two unrelated pieces of work would merge
// into one row and the loss would be silent.
func checkNoIDCollisions(db *gorm.DB) error {
	var n int64
	if err := db.Raw(`SELECT COUNT(*) FROM reports r JOIN tasks t ON t.id = r.id`).Scan(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("%d id(s) exist as both a report and a task; copying them would merge two things into one", n)
	}
	return nil
}

// backfillProjectLists gives every channel somewhere on the board to land.
//
// One space per organization holding a list per project, rather than a space
// each: the number that identifies a report is scoped to its project, so a space
// per project would buy nothing and leave the navigator full of near-empty
// trees.
func backfillProjectLists(db *gorm.DB) error {
	var projects []domain.ReportProject
	if err := db.Where("list_id IS NULL OR list_id = ''").Find(&projects).Error; err != nil {
		return err
	}
	for i := range projects {
		p := &projects[i]
		spaceID, err := reportsSpaceFor(db, p.OrgID)
		if err != nil {
			return err
		}
		list := &domain.TaskList{SpaceID: spaceID, Name: p.Name}
		if err := db.Where("space_id = ? AND name = ?", spaceID, p.Name).First(&domain.TaskList{}).Error; err == nil {
			// Already made on an earlier boot; find it rather than making a second.
			var found domain.TaskList
			if err := db.Where("space_id = ? AND name = ?", spaceID, p.Name).First(&found).Error; err != nil {
				return err
			}
			list = &found
		} else {
			list.Rank = "U"
			if err := db.Create(list).Error; err != nil {
				return err
			}
		}
		if err := db.Model(&domain.ReportProject{}).Where("id = ?", p.ID).
			Update("list_id", list.ID).Error; err != nil {
			return err
		}
	}
	return nil
}

// reportsSpaceFor finds or creates the one space an organization's channels land in.
func reportsSpaceFor(db *gorm.DB, orgID string) (string, error) {
	const name = "Reportes"
	var space domain.TaskSpace
	err := db.Where("org_id = ? AND name = ?", orgID, name).First(&space).Error
	if err == nil {
		return space.ID, nil
	}
	if !isNotFound(err) {
		return "", err
	}
	space = domain.TaskSpace{OrgID: orgID, Name: name, Rank: "U"}
	if err := db.Create(&space).Error; err != nil {
		return "", err
	}
	return space.ID, nil
}

func isNotFound(err error) bool { return err == gorm.ErrRecordNotFound }

// copyReportsToItems brings the channel side across, soft-deleted rows included:
// a withdrawn report is still part of the record, and its number is still spent.
func copyReportsToItems(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO items (
			id, created_at, updated_at, org_id, list_id, space_id, project_id, seq,
			title, description, status, category, priority, area, origin,
			url, user_agent, viewport, telemetry, telemetry_purge_at,
			reporter_name, reporter_email, reporter_id,
			rank, idempotency_key, resolved_at, created_by_id, deleted_at
		)
		SELECT
			r.id, r.created_at, r.updated_at, COALESCE(p.org_id, ''),
			COALESCE(p.list_id, ''), COALESCE(l.space_id, ''), r.project_id, r.seq,
			r.title, r.description, r.status, r.category, r.priority, r.area, r.origin,
			r.url, r.user_agent, r.viewport, r.telemetry, r.telemetry_purge_at,
			r.reporter_name, r.reporter_email, r.reporter_id,
			'', '', r.resolved_at, '', r.deleted_at
		FROM reports r
		-- LEFT, not INNER. ReportProject has no soft-delete, so a deleted project
		-- leaves its reports pointing at nothing. Those rows are already
		-- half-broken, but dropping them here would make the copy come up short
		-- and the verification refuse to start the pod — a backend that won't
		-- boot because of data that predates this whole feature.
		LEFT JOIN report_projects p ON p.id = r.project_id
		LEFT JOIN task_lists l ON l.id = p.list_id
		ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at,
			org_id = excluded.org_id,
			list_id = excluded.list_id,
			space_id = excluded.space_id,
			title = excluded.title,
			description = excluded.description,
			status = excluded.status,
			category = excluded.category,
			priority = excluded.priority,
			area = excluded.area,
			resolved_at = excluded.resolved_at,
			deleted_at = excluded.deleted_at
		WHERE excluded.updated_at > items.updated_at`).Error
	// telemetry is left out of the update on purpose: the old code may purge a
	// blob after this row was copied, and re-copying would put it back.
}

// copyTasksToItems folds the configurable columns onto the shared state machine.
//
// The mapping reads the column's `kind`, never its name — the whole reason kind
// exists is that someone renaming "Done" to "Shipped" must not change what the
// column means.
func copyTasksToItems(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO items (
			id, created_at, updated_at, org_id, list_id, space_id, project_id, seq,
			title, description, status, category, priority, area, origin,
			rank, idempotency_key, parent_id, start_at, due_at, resolved_at,
			created_by_id, archived_at
		)
		SELECT
			t.id, t.created_at, t.updated_at, t.org_id, t.list_id, COALESCE(l.space_id, ''), '', t.seq,
			t.title, t.description,
			CASE s.kind
				WHEN 'done'   THEN 'resolved'
				WHEN 'active' THEN 'in_progress'
				ELSE 'pending'
			END,
			'other',
			CASE t.priority WHEN 'normal' THEN 'medium' ELSE t.priority END,
			'', 'internal',
			t.rank, t.idempotency_key, t.parent_id, t.start_at, t.due_at, t.completed_at,
			t.created_by_id, t.archived_at
		FROM tasks t
		-- Same reasoning as above: a stray row must be carried, not silently
		-- dropped into a failed boot.
		LEFT JOIN task_lists l ON l.id = t.list_id
		LEFT JOIN task_statuses s ON s.id = t.status_id
		ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at,
			org_id = excluded.org_id,
			list_id = excluded.list_id,
			space_id = excluded.space_id,
			title = excluded.title,
			description = excluded.description,
			status = excluded.status,
			priority = excluded.priority,
			rank = excluded.rank,
			parent_id = excluded.parent_id,
			start_at = excluded.start_at,
			due_at = excluded.due_at,
			resolved_at = excluded.resolved_at,
			archived_at = excluded.archived_at
		WHERE excluded.updated_at > items.updated_at`).Error
}

// copyReportCommentsToItems: everything on a report's thread is public.
//
// Including the 'system' ones. The reporter is shown "status: pending →
// in_progress" today, so filing those as internal would quietly take away
// something they can already see.
func copyReportCommentsToItems(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO item_comments (
			id, created_at, updated_at, item_id, kind, visibility,
			author_user_id, author_project_id, author_external_id, author_external_name,
			body, deleted_at
		)
		SELECT
			c.id, c.created_at, c.updated_at, c.report_id, c.kind, 'public',
			c.author_user_id, c.author_project_id, c.author_external_id, c.author_external_name,
			c.body, c.deleted_at
		FROM report_comments c
		ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at,
			body = excluded.body,
			deleted_at = excluded.deleted_at
		WHERE excluded.updated_at > item_comments.updated_at`).Error
}

// copyTaskCommentsToItems: everything on a task's thread is internal — that is
// what it always was; there was nobody outside to show it to.
//
// The empty author id becomes NULL, and only here. On the channel side "no
// author" is how the reporter is recognised, so an empty string arriving there
// would read as a message from a reporter who doesn't exist.
func copyTaskCommentsToItems(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO item_comments (
			id, created_at, updated_at, item_id, kind, visibility,
			author_user_id, body
		)
		SELECT
			c.id, c.created_at, c.updated_at, c.task_id, 'user', 'internal',
			NULLIF(c.author_user_id, ''), c.body
		FROM task_comments c
		ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at,
			body = excluded.body
		WHERE excluded.updated_at > item_comments.updated_at`).Error
}

// copyReportImagesToItems. No url: a report's bytes are served through a signed,
// short-lived link computed at read time, and writing one down here would move
// them onto a route with different authorization.
func copyReportImagesToItems(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO item_attachments (
			id, created_at, updated_at, item_id, comment_id, path, url, file_name, deleted_at
		)
		SELECT
			i.id, i.created_at, i.updated_at, i.report_id, i.comment_id,
			i.path, '', i.file_name, i.deleted_at
		FROM report_images i
		ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at,
			deleted_at = excluded.deleted_at
		WHERE excluded.updated_at > item_attachments.updated_at`).Error
}

func copyTaskAttachmentsToItems(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO item_attachments (
			id, created_at, updated_at, item_id, comment_id, path, url,
			file_name, content_type, bytes, uploaded_by
		)
		SELECT
			a.id, a.created_at, a.updated_at, a.task_id, a.comment_id, a.path, a.url,
			a.file_name, a.content_type, a.bytes, a.uploaded_by
		FROM task_attachments a
		ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at,
			url = excluded.url,
			path = excluded.path
		WHERE excluded.updated_at > item_attachments.updated_at`).Error
}

// verifyItemCounts is the gate. Every old row has to have a new one.
//
// Counting is a weak check on its own — it says nothing about whether the fields
// arrived intact — but it catches the failure that matters here, which is a copy
// that stopped early, and it catches it before anything reads the result.
func verifyItemCounts(db *gorm.DB) error {
	checks := []struct {
		what string
		old  string
		new  string
	}{
		{"reports", `SELECT COUNT(*) FROM reports`, `SELECT COUNT(*) FROM items WHERE project_id <> ''`},
		{"tasks", `SELECT COUNT(*) FROM tasks`, `SELECT COUNT(*) FROM items WHERE project_id = ''`},
		{"report comments", `SELECT COUNT(*) FROM report_comments`, `SELECT COUNT(*) FROM item_comments WHERE visibility = 'public'`},
		{"task comments", `SELECT COUNT(*) FROM task_comments`, `SELECT COUNT(*) FROM item_comments WHERE visibility = 'internal'`},
		// Counted by which side the item came from, not by whether a url is set:
		// an older task attachment with an empty url would otherwise be tallied as
		// a report image, passing one check and failing the other.
		{"report images", `SELECT COUNT(*) FROM report_images`,
			`SELECT COUNT(*) FROM item_attachments a JOIN items i ON i.id = a.item_id WHERE i.project_id <> ''`},
		{"task attachments", `SELECT COUNT(*) FROM task_attachments`,
			`SELECT COUNT(*) FROM item_attachments a JOIN items i ON i.id = a.item_id WHERE i.project_id = ''`},
	}
	for _, c := range checks {
		var before, after int64
		if err := db.Raw(c.old).Scan(&before).Error; err != nil {
			return fmt.Errorf("counting %s: %w", c.what, err)
		}
		if err := db.Raw(c.new).Scan(&after).Error; err != nil {
			return fmt.Errorf("counting copied %s: %w", c.what, err)
		}
		if after < before {
			return fmt.Errorf("%s: %d in the old table, %d copied — the copy is short, refusing to serve",
				c.what, before, after)
		}
	}

	// A channel item outside the state machine would be a card no board can
	// place, and a status a tenant can't move.
	var stray int64
	if err := db.Raw(`SELECT COUNT(*) FROM items
		WHERE project_id <> '' AND status NOT IN ('pending','in_progress','resolved','closed')`).
		Scan(&stray).Error; err != nil {
		return err
	}
	if stray > 0 {
		return fmt.Errorf("%d channel item(s) carry a status outside the state machine", stray)
	}

	// The folio has to keep naming one thing — but *who* broke it decides what to
	// do about it. A duplicate the copy invented is a bug in this code and stops
	// the deploy. A duplicate the copy found was already live, sits in the old
	// table too, and gets reported instead: refusing to boot would take the
	// service down over something that has been true for weeks.
	var copied, existing int64
	if err := db.Raw(`SELECT COUNT(*) FROM (
			SELECT project_id, seq FROM items WHERE project_id <> ''
			GROUP BY project_id, seq HAVING COUNT(*) > 1
		) d`).Scan(&copied).Error; err != nil {
		return err
	}
	if copied == 0 {
		return nil
	}
	if err := db.Raw(`SELECT COUNT(*) FROM (
			SELECT project_id, seq FROM reports
			GROUP BY project_id, seq HAVING COUNT(*) > 1
		) d`).Scan(&existing).Error; err != nil {
		return err
	}
	if copied > existing {
		return fmt.Errorf("the copy created %d duplicate folio(s) that the old table doesn't have",
			copied-existing)
	}
	lg.Error(fmt.Sprintf("items migration: %d folio(s) already named more than one report before this ran; "+
		"they need repairing, and the uniqueness constraint can't exist until they are", existing))
	return nil
}

// EffectiveChannel answers "if I create something in this list, whose board does
// it reach?" — the list's own binding, falling back to the space above it.
//
// "" means nothing outside cac sees it. That is the answer for most lists, and
// it is the answer the caller gets if the list has vanished: an unknown list is
// not a reason to publish something to a tenant.
func (r *TaskRepository) EffectiveChannel(listID string) (string, error) {
	var row struct {
		ListProject  *string
		SpaceProject *string
	}
	err := r.db.Raw(`
		SELECT l.project_id AS list_project, s.project_id AS space_project
		FROM task_lists l
		JOIN task_spaces s ON s.id = l.space_id
		WHERE l.id = ?`, listID).Scan(&row).Error
	if err != nil {
		return "", err
	}
	if row.ListProject != nil && *row.ListProject != "" {
		return *row.ListProject, nil
	}
	if row.SpaceProject != nil && *row.SpaceProject != "" {
		return *row.SpaceProject, nil
	}
	return "", nil
}

// BindListToChannel points a list at a tenant's channel, or clears it with "".
//
// The project has to belong to the same organization as the list. Without that
// check, binding would be a way to push work onto another tenant's board — and
// the person doing it would have no reason to think that was possible.
func (r *TaskRepository) BindListToChannel(listID, projectID string) error {
	if projectID == "" {
		return r.db.Model(&domain.TaskList{}).Where("id = ?", listID).
			Update("project_id", nil).Error
	}
	ok, err := r.channelSharesOrgWithList(listID, projectID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrChannelOtherOrg
	}
	return r.db.Model(&domain.TaskList{}).Where("id = ?", listID).
		Update("project_id", projectID).Error
}

// BindSpaceToChannel does the same for a whole space.
func (r *TaskRepository) BindSpaceToChannel(spaceID, projectID string) error {
	if projectID == "" {
		return r.db.Model(&domain.TaskSpace{}).Where("id = ?", spaceID).
			Update("project_id", nil).Error
	}
	var same int64
	if err := r.db.Raw(`SELECT COUNT(*) FROM task_spaces s
		JOIN report_projects p ON p.id = ?
		WHERE s.id = ? AND s.org_id = p.org_id`, projectID, spaceID).Scan(&same).Error; err != nil {
		return err
	}
	if same == 0 {
		return ErrChannelOtherOrg
	}
	return r.db.Model(&domain.TaskSpace{}).Where("id = ?", spaceID).
		Update("project_id", projectID).Error
}

func (r *TaskRepository) channelSharesOrgWithList(listID, projectID string) (bool, error) {
	var n int64
	err := r.db.Raw(`SELECT COUNT(*) FROM task_lists l
		JOIN task_spaces s ON s.id = l.space_id
		JOIN report_projects p ON p.id = ?
		WHERE l.id = ? AND s.org_id = p.org_id`, projectID, listID).Scan(&n).Error
	return n > 0, err
}

// SetChannelInbox is where a channel's incoming reports land.
func (r *TaskRepository) SetChannelInbox(projectID, listID string) error {
	return r.db.Model(&domain.ReportProject{}).Where("id = ?", projectID).
		Update("list_id", listID).Error
}

// RetractFromChannel takes an item off a client's board.
//
// The channel and the number both stay. Clearing the channel would look tidier
// and would hand the next item the same folio — the client would then have two
// different things called the same name, one of which they may already have
// quoted. A gap in their numbering is the honest record.
func (r *TaskRepository) RetractFromChannel(itemID string) error {
	return r.db.Model(&domain.Item{}).Where("id = ?", itemID).
		Update("visibility", domain.VisibilityInternal).Error
}

// PublishToChannel puts an internal item on a client's board, giving it the next
// folio of that channel. Returns the number it was given.
func (r *TaskRepository) PublishToChannel(itemID, projectID string) (int, error) {
	var seq int
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// Unscoped, like every other place a folio is allocated: a soft-deleted
		// row still owns its number.
		var maxSeq int
		if err := tx.Unscoped().Raw(
			`SELECT COALESCE(MAX(seq),0) FROM items WHERE project_id = ?`, projectID).
			Scan(&maxSeq).Error; err != nil {
			return err
		}
		seq = maxSeq + 1
		return tx.Model(&domain.Item{}).Where("id = ?", itemID).
			Updates(map[string]any{
				"project_id": projectID, "seq": seq,
				"visibility": domain.VisibilityPublic,
			}).Error
	})
	return seq, err
}

// MoveTaskToList moves a card to another list.
//
// space_id travels with it, because it is denormalised onto the row and is what
// scopes internal numbering and keeps the report queries off the task tables. A
// stale one would put the card in a space it isn't in.
//
// The rank is recomputed: the orders of two lists have nothing to do with each
// other, so carrying the old one over would drop the card in an arbitrary spot.
func (r *TaskRepository) MoveTaskToList(itemID, listID string) error {
	var dest struct {
		SpaceID string
		OrgID   string
	}
	if err := r.db.Raw(`
		SELECT l.space_id, s.org_id FROM task_lists l
		JOIN task_spaces s ON s.id = l.space_id
		WHERE l.id = ?`, listID).Scan(&dest).Error; err != nil {
		return err
	}
	if dest.SpaceID == "" {
		return ErrListNotFound
	}

	var item domain.Item
	if err := r.db.First(&item, "id = ?", itemID).Error; err != nil {
		return err
	}
	// Same organization, always. Crossing that line would show the card to people
	// who cannot see the list it came from — and nobody dragging something
	// between two boards is expressing that intent.
	if item.OrgID != "" && item.OrgID != dest.OrgID {
		return ErrChannelOtherOrg
	}

	last := r.nextRank("items", "list_id = ? AND status = ?", listID, item.Status)
	return r.db.Model(&domain.Item{}).Where("id = ?", itemID).
		Updates(map[string]any{
			"list_id": listID, "space_id": dest.SpaceID, "rank": last,
		}).Error
}

// ─── Who is responsible ───────────────────────────────────────────────────────

// PrimaryAssignee is the person a tenant is shown, and "" when nobody is on it.
func (r *ReportRepository) PrimaryAssignee(itemID string) (string, error) {
	var id string
	err := r.db.Raw(`SELECT user_id FROM task_assignees
		WHERE task_id = ? ORDER BY "primary" DESC LIMIT 1`, itemID).Scan(&id).Error
	return id, err
}

// SetPrimaryAssignee is the single-assignee path the report contract exposes:
// naming someone replaces whoever was there, and "" clears the card.
//
// It writes the same table the board writes, which is the whole point — the two
// used to be different places, so assigning on one side left the other showing
// something else and neither looked wrong by itself.
func (r *ReportRepository) SetPrimaryAssignee(itemID, userID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("task_id = ?", itemID).Delete(&domain.TaskAssignee{}).Error; err != nil {
			return err
		}
		if userID == "" {
			return nil
		}
		return tx.Create(&domain.TaskAssignee{TaskID: itemID, UserID: userID, Primary: true}).Error
	})
}

// PromoteAnAssignee makes sure somebody is primary while anybody is on the card.
//
// Removing the primary from a card two other people are working on used to leave
// the tenant's board reading "unassigned" — the one summary that misleads,
// because it says nobody is on something that is actively being worked.
func (r *ReportRepository) PromoteAnAssignee(itemID string) error {
	var n int64
	if err := r.db.Model(&domain.TaskAssignee{}).
		Where(`task_id = ? AND "primary" = true`, itemID).Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	return r.db.Exec(`UPDATE task_assignees SET "primary" = true
		WHERE task_id = ? AND user_id = (
			SELECT user_id FROM task_assignees WHERE task_id = ? LIMIT 1
		)`, itemID, itemID).Error
}

// backfillAssignees moves the report side's single column into the shared table.
//
// Idempotent by the conflict clause: a card that already has its people keeps
// them, and the column stops being read once this has run.
func backfillAssignees(db *gorm.DB) error {
	return db.Exec(`
		INSERT INTO task_assignees (task_id, user_id, "primary")
		SELECT i.id, i.assignee_user_id, true
		FROM items i
		WHERE i.assignee_user_id IS NOT NULL AND i.assignee_user_id <> ''
		ON CONFLICT (task_id, user_id) DO UPDATE SET "primary" = true`).Error
}
