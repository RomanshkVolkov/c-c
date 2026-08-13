package repository

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Does the copy actually carry everything across, and does it say so honestly?
//
// The promise made about this migration was no data loss and no change to what
// anyone outside can see. Both of those are properties of the copy, so they get
// checked against a real database with a real old-world dataset in it — the two
// modules as they exist today, including the awkward rows: a renamed column, a
// withdrawn comment, an image inside a comment.

func TestTheCopyCarriesBothModulesAcross(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)

	migrateItems(db)

	// ── The channel side ──
	var rep domain.Item
	if err := db.First(&rep, "id = ?", "rep-1").Error; err != nil {
		t.Fatalf("the report didn't arrive: %v", err)
	}
	if rep.ProjectID != "proj-1" {
		t.Errorf("a report is an item with a channel; project_id = %q", rep.ProjectID)
	}
	if rep.Seq != 7 {
		t.Errorf("seq is the public name of the report: want 7, got %d", rep.Seq)
	}
	if rep.OrgID != "org-1" {
		t.Errorf("org_id comes from the project: want org-1, got %q", rep.OrgID)
	}
	if rep.ListID == "" || rep.SpaceID == "" {
		t.Errorf("a channel item needs somewhere on the board: list=%q space=%q", rep.ListID, rep.SpaceID)
	}

	// ── The internal side, and the column that got renamed ──
	var task domain.Item
	if err := db.First(&task, "id = ?", "task-done").Error; err != nil {
		t.Fatalf("the task didn't arrive: %v", err)
	}
	if task.ProjectID != "" {
		t.Errorf("a task has no channel; got project_id %q", task.ProjectID)
	}
	// The column was called "Shipped", not "Done". Reading the name would have
	// filed this as unfinished — the kind is what carries the meaning.
	if task.Status != domain.ReportResolved {
		t.Errorf("a card in a done-kind column is resolved whatever the column is called; got %q", task.Status)
	}
	if task.ResolvedAt == nil {
		t.Error("completed_at should have become resolved_at")
	}
	if task.Priority != domain.ItemPriorityMedium {
		t.Errorf("`normal` and `medium` were the same rung: want medium, got %q", task.Priority)
	}
	if task.Origin != "internal" {
		t.Errorf("work raised inside cac is internal in origin, got %q", task.Origin)
	}

	// ── The whole point of the merge: two audiences, one table ──
	var pub, internal domain.ItemComment
	if err := db.First(&pub, "id = ?", "cmt-report").Error; err != nil {
		t.Fatal(err)
	}
	if pub.Visibility != domain.VisibilityPublic {
		t.Errorf("a report comment is part of the conversation with the reporter; got %q", pub.Visibility)
	}
	if err := db.First(&internal, "id = ?", "cmt-task").Error; err != nil {
		t.Fatal(err)
	}
	if internal.Visibility != domain.VisibilityInternal {
		t.Errorf("a task comment never had anyone outside to show it to; got %q", internal.Visibility)
	}
	// The system note the reporter can already read stays readable.
	var sys domain.ItemComment
	if err := db.First(&sys, "id = ?", "cmt-system").Error; err != nil {
		t.Fatal(err)
	}
	if sys.Visibility != domain.VisibilityPublic {
		t.Error("the reporter is shown 'status: x → y' today; filing it internal would take that away")
	}
	// A withdrawn comment is hidden, not destroyed.
	var withdrawn int64
	db.Unscoped().Model(&domain.ItemComment{}).Where("id = ? AND deleted_at IS NOT NULL", "cmt-withdrawn").Count(&withdrawn)
	if withdrawn != 1 {
		t.Error("a withdrawn comment should arrive still withdrawn, not missing and not restored")
	}
	// And an empty author id must not become "the reporter" on the internal side.
	if internal.AuthorUserID == nil || *internal.AuthorUserID != "u-1" {
		t.Errorf("task comment author lost: %v", internal.AuthorUserID)
	}
	var orphan domain.ItemComment
	if err := db.First(&orphan, "id = ?", "cmt-task-noauthor").Error; err != nil {
		t.Fatal(err)
	}
	if orphan.AuthorUserID != nil {
		t.Errorf("an empty author id becomes NULL, not \"\": got %v", *orphan.AuthorUserID)
	}

	// ── Attachments, and which route serves them ──
	var img domain.ItemAttachment
	if err := db.First(&img, "id = ?", "img-1").Error; err != nil {
		t.Fatal(err)
	}
	if img.URL != "" {
		t.Errorf("a report's bytes are served through a signed link computed on read; a stored url moves them onto another route with different auth. got %q", img.URL)
	}
	if img.CommentID == nil || *img.CommentID != "cmt-report" {
		t.Error("an image posted inside a comment stays inside that comment")
	}
	var att domain.ItemAttachment
	if err := db.First(&att, "id = ?", "att-1").Error; err != nil {
		t.Fatal(err)
	}
	if att.URL == "" {
		t.Error("an internal attachment keeps its proxy reference — the markdown that embeds it points there")
	}

}

// Running it again must be free. It runs on every boot, so anything else would
// duplicate rows or undo work each time a pod restarts.
func TestRunningTheCopyTwiceChangesNothing(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)

	migrateItems(db)
	snapshot := countEverything(t, db)

	migrateItems(db)
	again := countEverything(t, db)

	for what, before := range snapshot {
		if again[what] != before {
			t.Errorf("%s: %d after one run, %d after two", what, before, again[what])
		}
	}

	// And the channel didn't get a second list to land in.
	var lists int64
	db.Model(&domain.TaskList{}).Where("name = ?", "Acme Support").Count(&lists)
	if lists != 1 {
		t.Errorf("the project's landing list was created %d times", lists)
	}
}

// The gate has to actually refuse. A copy that stopped early looks like a
// populated table, and the phase that reads it would serve short lists with a
// 200 — the failure nobody notices.
func TestVerificationRefusesAShortCopy(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)

	migrateItems(db)
	if err := verifyItemCounts(db); err != nil {
		t.Fatalf("a complete copy should verify: %v", err)
	}

	// Lose one row, the way a copy interrupted halfway would.
	if err := db.Exec(`DELETE FROM items WHERE id = 'rep-1'`).Error; err != nil {
		t.Fatal(err)
	}
	if err := verifyItemCounts(db); err == nil {
		t.Fatal("a short copy has to be refused, not served")
	}
}

// Two things sharing a folio makes the public name of a report ambiguous, and
// there is no fixing it afterwards.
func TestVerificationRefusesADuplicateFolio(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)

	// Reach around the unique index to plant what a bad copy would have made.
	if err := db.Exec(`DROP INDEX IF EXISTS idx_items_seq_project`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO items (id, created_at, updated_at, project_id, seq, title, status, priority)
		VALUES ('rep-dupe', now(), now(), 'proj-1', 7, 'el mismo número', 'pending', 'medium')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := verifyItemCounts(db); err == nil {
		t.Fatal("two items called acme-7 has to be refused")
	}
}

func countEverything(t *testing.T, db *gorm.DB) map[string]int64 {
	t.Helper()
	out := map[string]int64{}
	for what, q := range map[string]string{
		"items":       `SELECT COUNT(*) FROM items`,
		"comments":    `SELECT COUNT(*) FROM item_comments`,
		"attachments": `SELECT COUNT(*) FROM item_attachments`,
		"spaces":      `SELECT COUNT(*) FROM task_spaces`,
		"lists":       `SELECT COUNT(*) FROM task_lists`,
	} {
		var n int64
		if err := db.Raw(q).Scan(&n).Error; err != nil {
			t.Fatal(err)
		}
		out[what] = n
	}
	return out
}

// seedOldWorld builds the two modules as they are today, including the rows that
// are easy to get wrong.
func seedOldWorld(t *testing.T, db *gorm.DB) {
	t.Helper()
	mk := func(v any) {
		if err := db.Create(v).Error; err != nil {
			t.Fatal(err)
		}
	}

	org := &domain.Organization{Name: "Org One", Slug: "org-one"}
	org.ID = "org-1"
	mk(org)

	user := &domain.User{Username: "ana", Email: "ana@example.com", Password: "x"}
	user.ID = "u-1"
	mk(user)

	proj := &domain.ReportProject{
		OrgID: "org-1", Name: "Acme Support", Slug: "acme",
		IngestKeyHash: []byte("h"), IsActive: true, Platform: "app",
	}
	proj.ID = "proj-1"
	mk(proj)

	if err := db.Exec(`INSERT INTO reports
		(id, created_at, updated_at, project_id, seq, title, description, status,
		 reporter_id, reporter_name, assignee_user_id)
		VALUES ('rep-1', now(), now(), 'proj-1', 7, 'algo se rompió', 'detalle', 'pending',
		        'ext-9', 'Quien reporta', 'u-1')`).Error; err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ id, kind, body, deleted string }{
		{"cmt-report", "user", "respuesta", "NULL"},
		{"cmt-system", "system", "status: pending → in_progress", "NULL"},
		{"cmt-withdrawn", "user", "esto se retiró", "now()"},
	} {
		if err := db.Exec(`INSERT INTO report_comments
			(id, created_at, updated_at, report_id, kind, author_user_id, body, deleted_at)
			VALUES (?, now(), now(), 'rep-1', ?, 'u-1', ?, `+c.deleted+`)`,
			c.id, c.kind, c.body).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec(`INSERT INTO report_images
		(id, created_at, updated_at, report_id, comment_id, path, file_name)
		VALUES ('img-1', now(), now(), 'rep-1', 'cmt-report', 'r/one.png', 'one.png')`).
		Error; err != nil {
		t.Fatal(err)
	}

	// ── The task side, with a renamed column ──
	space := &domain.TaskSpace{OrgID: "org-1", Name: "Producto", Rank: "U"}
	space.ID = "space-1"
	mk(space)
	list := &domain.TaskList{SpaceID: "space-1", Name: "Sprint", Rank: "U"}
	list.ID = "list-1"
	mk(list)
	shipped := &domain.TaskStatus{ListID: "list-1", Name: "Shipped", Kind: domain.StatusKindDone, Rank: "U"}
	shipped.ID = "st-done"
	mk(shipped)

	completed := time.Now().Add(-24 * time.Hour)
	// Built as the OLD world had it: raw SQL, because domain.Task now describes
	// the unified row and this fixture has to look like what production is being
	// migrated *from*.
	task := &domain.Task{}
	task.ID = "task-done"
	if err := db.Exec(`INSERT INTO tasks
		(id, created_at, updated_at, list_id, status_id, org_id, seq, title, priority, completed_at, created_by_id)
		VALUES ('task-done', now(), now(), 'list-1', 'st-done', 'org-1', 3, 'ya salió', 'normal', ?, 'u-1')`,
		completed).Error; err != nil {
		t.Fatal(err)
	}
	_ = task
	if err := db.Exec(`INSERT INTO task_comments (id, created_at, updated_at, task_id, author_user_id, body)
		VALUES ('cmt-task', now(), now(), 'task-done', 'u-1', 'nota del equipo')`).Error; err != nil {
		t.Fatal(err)
	}

	// An author id that was never filled in — on the channel side that shape
	// means "the reporter", so it must not travel as an empty string.
	if err := db.Exec(`INSERT INTO task_comments (id, created_at, updated_at, task_id, author_user_id, body)
		VALUES ('cmt-task-noauthor', now(), now(), 'task-done', '', 'sin autor')`).Error; err != nil {
		t.Fatal(err)
	}

	if err := db.Exec(`INSERT INTO task_attachments
		(id, created_at, updated_at, task_id, path, file_name, url, content_type, bytes)
		VALUES ('att-1', now(), now(), 'task-done', 't/spec.pdf', 'spec.pdf', ?, 'application/pdf', 10)`,
		domain.AttachmentRef("task-done", "att-1")).Error; err != nil {
		t.Fatal(err)
	}

	mk(&domain.TaskAssignee{TaskID: "task-done", UserID: "u-1"})
}

func itemMigrationDB(t *testing.T) (*gorm.DB, func()) {
	t.Helper()
	if GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			GetEnv("DB_HOST", "localhost"), GetEnv("DB_PORT", "5432"),
			GetEnv("DB_USER", "postgres"), GetEnv("DB_PASSWORD", ""),
			name, GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_item_migration"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&domain.User{}, &domain.Organization{},
		&domain.ReportProject{},
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.TaskAssignee{},
		&domain.TaskTag{}, &domain.TaskTagLink{},
		&domain.Item{}, &domain.ItemComment{}, &domain.ItemAttachment{},
	); err != nil {
		t.Fatal(err)
	}
	if err := createLegacyTables(db); err != nil {
		t.Fatal(err)
	}
	return db, func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

// A report whose project was deleted must still be copied.
//
// ReportProject has no soft-delete, so deleting one leaves its reports behind
// with a project_id pointing at nothing. Those rows are already half-broken —
// but an inner join would drop them from the copy, the count would come up
// short, and the verification would panic. That is a backend refusing to start
// because of data that was already there before this feature existed.
func TestAReportWhoseProjectIsGoneIsStillCopied(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)

	orphan := &domain.Report{
		ProjectID: "proj-vanished", Seq: 1, Title: "de un proyecto borrado",
		Status: domain.ReportPending,
	}
	orphan.ID = "rep-orphan"
	if err := db.Create(orphan).Error; err != nil {
		t.Fatal(err)
	}

	migrateItems(db) // must not panic

	var got domain.Item
	if err := db.First(&got, "id = ?", "rep-orphan").Error; err != nil {
		t.Fatalf("the orphaned report was dropped instead of copied: %v", err)
	}
	if got.ProjectID != "proj-vanished" {
		t.Errorf("its channel id is kept as-is, broken or not; got %q", got.ProjectID)
	}
}

// Same shape on the internal side: a task whose list is gone.
func TestATaskWhoseListIsGoneIsStillCopied(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)

	if err := db.Exec(`INSERT INTO tasks (id, created_at, updated_at, list_id, status_id, org_id, seq, title, priority)
		VALUES ('task-orphan', now(), now(), 'list-vanished', 'st-gone', 'org-1', 99, 'de una lista borrada', 'none')`).
		Error; err != nil {
		t.Fatal(err)
	}

	migrateItems(db) // must not panic

	var got domain.Item
	if err := db.First(&got, "id = ?", "task-orphan").Error; err != nil {
		t.Fatalf("the orphaned task was dropped instead of copied: %v", err)
	}
	// No column to read a kind from, so it lands in the first state rather than
	// being guessed into a finished one.
	if got.Status != domain.ReportPending {
		t.Errorf("with no column to read, the safe landing state is pending; got %q", got.Status)
	}
}

// Folios that were already duplicated must not stop the backend from starting.
//
// The seq-reuse bug shipped, so a production database may already hold two
// reports with the same number. Creating a unique index over that data is
// impossible — and panicking on it would mean a crash loop over data that has
// been sitting there for weeks, taking the service down without helping anyone
// fix it.
//
// The rule this encodes: a problem the copy *created* stops the deploy; a problem
// the copy *found* gets reported loudly and the service keeps running. Nothing
// reads these tables yet, so a missing index costs nothing today.
func TestPreexistingDuplicateFoliosDoNotBlockTheBoot(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)

	// Two reports of the same project sharing number 7 — exactly what the old
	// MAX(seq) produced after a withdrawal. Inserted into the table being migrated
	// *from*: a duplicate that only exists in the destination would mean the copy
	// invented it, which is the case that must still stop the deploy.
	if err := db.Exec(`INSERT INTO reports (id, created_at, updated_at, project_id, seq, title, status)
		VALUES ('rep-twin', now(), now(), 'proj-1', 7, 'el gemelo', 'pending')`).Error; err != nil {
		t.Fatal(err)
	}

	migrateItems(db) // must not panic

	// Both arrived: nothing was quietly dropped to make the index possible.
	var n int64
	db.Model(&domain.Item{}).Where("project_id = ? AND seq = ?", "proj-1", 7).Count(&n)
	if n != 2 {
		t.Errorf("both twins should be copied, found %d", n)
	}
}

// The list a channel delivers into cannot be deleted out from under it.
//
// Today that would leave the project pointing at nothing. After the switch-over
// the same cascade would physically destroy every report of that tenant, and the
// urls they have stored would start answering 404. The guard goes in before the
// data is there to lose.
func TestTheListAChannelDeliversIntoCannotBeDeleted(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db) // gives proj-1 its landing list

	var proj domain.ReportProject
	if err := db.First(&proj, "id = ?", "proj-1").Error; err != nil {
		t.Fatal(err)
	}
	if proj.ListID == nil || *proj.ListID == "" {
		t.Fatal("the migration should have given the project a list to deliver into")
	}
	repo := NewTaskRepository(db)

	if err := repo.DeleteList(*proj.ListID); err != ErrListInUseByChannel {
		t.Errorf("deleting the landing list must be refused, got %v", err)
	}
	var still int64
	db.Model(&domain.TaskList{}).Where("id = ?", *proj.ListID).Count(&still)
	if still != 1 {
		t.Error("the list is still there — a refused delete must not delete anything")
	}

	// The other door into the same cascade.
	var list domain.TaskList
	if err := db.First(&list, "id = ?", *proj.ListID).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteSpace(list.SpaceID); err != ErrListInUseByChannel {
		t.Errorf("deleting the space above it must be refused too, got %v", err)
	}

	// And an ordinary list is still deletable: the guard is narrow.
	if err := repo.DeleteList("list-1"); err != nil {
		t.Errorf("a list no channel delivers into should still delete: %v", err)
	}
}

// Which board does work created here reach?
//
// The rule the owner chose: what the team is working on should be visible to the
// client by default, with a deliberate way to keep something private. So the
// binding lives on the node you are looking at — the list, or the space above
// it — and the answer has to be unambiguous, because getting it wrong either
// leaks internal work or silently hides work a client is paying for.
func TestWhichChannelALisReaches(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	repo := NewTaskRepository(db)

	// Unbound: nothing outside cac ever sees it. This is most lists.
	if got, err := repo.EffectiveChannel("list-1"); err != nil || got != "" {
		t.Errorf("an unbound list reaches nobody; got %q (%v)", got, err)
	}

	// Bound at the space: everything underneath inherits it, which is the point
	// of binding there — one setting for a client's whole space.
	if err := repo.BindSpaceToChannel("space-1", "proj-1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.EffectiveChannel("list-1"); got != "proj-1" {
		t.Errorf("a list under a bound space inherits it; got %q", got)
	}

	// The list wins over the space: one list of internal work inside a client's
	// space has to be possible, or the space-level setting is a trap.
	if err := repo.BindListToChannel("list-1", ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.EffectiveChannel("list-1"); got != "proj-1" {
		t.Errorf("clearing a list that never had its own binding leaves the space's; got %q", got)
	}

	// And a list can name a different channel than its space.
	other := &domain.ReportProject{OrgID: "org-1", Name: "Otro", Slug: "otro", IngestKeyHash: []byte("h2")}
	other.ID = "proj-2"
	if err := db.Create(other).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-2"); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.EffectiveChannel("list-1"); got != "proj-2" {
		t.Errorf("the list's own binding wins; got %q", got)
	}
}

// Binding across organizations would be a way to push work onto a tenant nobody
// here is meant to reach — and the person doing it would have no reason to think
// that was even possible.
func TestAChannelOfAnotherOrgCannotBeBound(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	repo := NewTaskRepository(db)

	elsewhere := &domain.Organization{Name: "Otra", Slug: "otra"}
	elsewhere.ID = "org-2"
	if err := db.Create(elsewhere).Error; err != nil {
		t.Fatal(err)
	}
	theirs := &domain.ReportProject{OrgID: "org-2", Name: "Suyo", Slug: "suyo", IngestKeyHash: []byte("h3")}
	theirs.ID = "proj-theirs"
	if err := db.Create(theirs).Error; err != nil {
		t.Fatal(err)
	}

	if err := repo.BindListToChannel("list-1", "proj-theirs"); err != ErrChannelOtherOrg {
		t.Errorf("binding a list to another org's channel must be refused, got %v", err)
	}
	if err := repo.BindSpaceToChannel("space-1", "proj-theirs"); err != ErrChannelOtherOrg {
		t.Errorf("same at the space level, got %v", err)
	}
	if got, _ := repo.EffectiveChannel("list-1"); got != "" {
		t.Errorf("a refused binding must not have been written; got %q", got)
	}
}

// An unknown list reaches nobody. A missing row is not a reason to publish
// something to a tenant.
func TestAnUnknownListReachesNobody(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	repo := NewTaskRepository(db)

	if got, err := repo.EffectiveChannel("list-that-never-existed"); err != nil || got != "" {
		t.Errorf("want no channel and no error, got %q (%v)", got, err)
	}
}

// Binding a list moves the channel's inbox to it.
//
// Saying "this list is portento's" and then having portento's reports keep
// arriving somewhere else would be a setting that lies. The migration had to
// guess an inbox; this is how that guess gets corrected.
func TestBindingAListAlsoMovesTheInbox(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db) // guesses an inbox
	repo := NewTaskRepository(db)

	var before domain.ReportProject
	if err := db.First(&before, "id = ?", "proj-1").Error; err != nil {
		t.Fatal(err)
	}
	if before.ListID == nil || *before.ListID == "list-1" {
		t.Fatalf("precondition: the guessed inbox should not already be list-1, got %v", before.ListID)
	}

	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetChannelInbox("proj-1", "list-1"); err != nil {
		t.Fatal(err)
	}

	var after domain.ReportProject
	if err := db.First(&after, "id = ?", "proj-1").Error; err != nil {
		t.Fatal(err)
	}
	if after.ListID == nil || *after.ListID != "list-1" {
		t.Errorf("the inbox should follow the binding, got %v", after.ListID)
	}
	// And the list a channel now delivers into is protected, wherever it moved to.
	if err := repo.DeleteList("list-1"); err != ErrListInUseByChannel {
		t.Errorf("the new inbox has to be guarded too, got %v", err)
	}
}

// createLegacyTaskTables builds the schema this migration reads *from*.
//
// Written as DDL rather than AutoMigrate because there are no Go structs left to
// describe it: domain.Task now names the unified row, and the types that
// described the old shape were replaced by aliases. Which is the honest thing —
// a fixture for a migration should look like the database being migrated, not
// like today's model with a few fields ignored.
func createLegacyTables(db *gorm.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS task_statuses (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			list_id varchar(36) NOT NULL, name varchar(60) NOT NULL,
			color varchar(20), kind varchar(20) DEFAULT 'open', rank varchar(64))`,
		`CREATE TABLE IF NOT EXISTS tasks (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			list_id varchar(36), status_id varchar(36), org_id varchar(36), seq int,
			title varchar(300), description text, priority varchar(10) DEFAULT 'none',
			idempotency_key varchar(120) DEFAULT '', rank varchar(64),
			start_at timestamptz, due_at timestamptz, completed_at timestamptz,
			created_by_id varchar(36), parent_id varchar(36), archived_at timestamptz)`,
		`CREATE TABLE IF NOT EXISTS task_comments (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			task_id varchar(36) NOT NULL, author_user_id varchar(36), body text NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS reports (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			project_id varchar(36) NOT NULL, seq int NOT NULL DEFAULT 0,
			title varchar(200) NOT NULL, description text,
			status varchar(20) DEFAULT 'pending', category varchar(20) DEFAULT 'other',
			priority varchar(10) DEFAULT 'medium', area varchar(60),
			origin varchar(10) DEFAULT 'user', url text, user_agent text, viewport varchar(50),
			telemetry bytea, telemetry_purge_at timestamptz,
			reporter_name varchar(120), reporter_email varchar(255), reporter_id varchar(255),
			assignee_user_id varchar(36), resolved_at timestamptz, deleted_at timestamptz)`,
		`CREATE TABLE IF NOT EXISTS report_comments (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			report_id varchar(36) NOT NULL, kind varchar(10) DEFAULT 'user',
			author_user_id varchar(36), author_project_id varchar(36),
			author_external_id varchar(255), author_external_name varchar(120),
			body text NOT NULL, deleted_at timestamptz)`,
		`CREATE TABLE IF NOT EXISTS report_images (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			report_id varchar(36) NOT NULL, comment_id varchar(36),
			path text NOT NULL, file_name varchar(255), deleted_at timestamptz)`,
		`CREATE TABLE IF NOT EXISTS task_attachments (
			id varchar(36) PRIMARY KEY, created_at timestamptz, updated_at timestamptz,
			task_id varchar(36) NOT NULL, comment_id varchar(36), url text, path text,
			file_name varchar(255), content_type varchar(120), bytes bigint,
			uploaded_by varchar(36))`,
	}
	for _, s := range stmts {
		if err := db.Exec(s).Error; err != nil {
			return err
		}
	}
	return nil
}

// Deleting a list hides its work; it doesn't destroy it.
//
// It used to be a hard delete: tasks, comments and attachments gone, no undo, no
// trace, and no way to tell afterwards whether anything had been in there. The
// row costs nothing to keep and the mistake stops being permanent.
func TestDeletingAListHidesItsWorkInsteadOfDestroyingIt(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	if err := repo.DeleteList("list-1"); err != nil {
		t.Fatal(err)
	}

	// Gone from every ordinary read…
	var visible int64
	db.Model(&domain.Item{}).Where("id = ?", "task-done").Count(&visible)
	if visible != 0 {
		t.Error("the task should be out of sight after its list is deleted")
	}
	// …and still there.
	var kept int64
	db.Unscoped().Model(&domain.Item{}).Where("id = ? AND deleted_at IS NOT NULL", "task-done").Count(&kept)
	if kept != 1 {
		t.Error("the task should still exist, marked deleted — losing it outright was the old behaviour")
	}
	var comments int64
	db.Unscoped().Model(&domain.ItemComment{}).
		Where("item_id = ? AND deleted_at IS NOT NULL", "task-done").Count(&comments)
	if comments == 0 {
		t.Error("its comments go the same way: hidden, not destroyed")
	}
}

// A client's ticket is not collateral damage of tidying up the tree.
func TestAListHoldingAClientsWorkIsNotDeleted(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	// Move the report into an ordinary list, and point the channel elsewhere so
	// the other guard isn't what answers.
	if err := db.Model(&domain.Item{}).Where("id = ?", "rep-1").
		Update("list_id", "list-1").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&domain.ReportProject{}).Where("id = ?", "proj-1").
		Update("list_id", nil).Error; err != nil {
		t.Fatal(err)
	}

	if err := repo.DeleteList("list-1"); err != ErrListHoldsChannelWork {
		t.Errorf("a list holding a client's report must not be deleted, got %v", err)
	}
	var still int64
	db.Model(&domain.Item{}).Where("id = ?", "rep-1").Count(&still)
	if still != 1 {
		t.Error("and nothing may have been hidden on the way to refusing")
	}
}

// The board, end to end, on the unified table.
//
// This is what an installed app asks for and what it sends back, so it is the
// thing the cutover can most easily break in a way nobody notices until a card
// won't move.
func TestABoardWorksOnTheUnifiedTable(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	// The columns are computed, and every state has one.
	cols, err := repo.Statuses("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(cols) != 4 {
		t.Fatalf("four fixed columns, got %d", len(cols))
	}

	// A card created through the normal path lands in the first column and gets
	// a number of its own.
	fresh := &domain.Task{ListID: "list-1", OrgID: "org-1", Title: "algo nuevo", Status: domain.ReportPending}
	if err := repo.CreateTask(fresh, "space-1"); err != nil {
		t.Fatal(err)
	}
	if fresh.Seq == 0 {
		t.Error("a new item should be numbered within its space")
	}
	if fresh.Rank == "" {
		t.Error("and ranked, or the board has no order to render")
	}

	cards, err := repo.Board("list-1")
	if err != nil {
		t.Fatal(err)
	}
	var found *domain.TaskCard
	for i := range cards {
		if cards[i].ID == fresh.ID {
			found = &cards[i]
		}
	}
	if found == nil {
		t.Fatal("the card we just made is not on its own board")
	}
	// The status id has to round-trip: the client reads it here and sends it back
	// to move the card. An id it can't return is a board where nothing moves.
	back, ok := domain.SplitSyntheticStatusID(found.StatusID)
	if !ok || back != domain.ReportPending {
		t.Errorf("status id %q does not name the state it is in", found.StatusID)
	}

	// Moving it: through the repository the way the service does.
	done := domain.ReportResolved
	now := time.Now()
	if err := repo.MoveTask(fresh.ID, done, "V", &now); err != nil {
		t.Fatal(err)
	}
	var moved domain.Item
	if err := db.First(&moved, "id = ?", fresh.ID).Error; err != nil {
		t.Fatal(err)
	}
	if moved.Status != done || moved.ResolvedAt == nil {
		t.Errorf("after moving to a finished column: status=%q resolvedAt=%v", moved.Status, moved.ResolvedAt)
	}

	// And the dashboard stops listing it, because finished is read off the state.
	open, err := repo.ListOpen([]string{"org-1"}, false, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range open {
		if o.ID == fresh.ID {
			t.Error("a finished item must not be on the pending list")
		}
	}
}

// A client's report never appears on a task board while the report path is still
// the one serving it: two copies, one of them silently stale, is worse than not
// showing it at all.
func TestAClientsReportStaysOffTheTaskBoard(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	// Put the migrated report in an ordinary list and look at that board.
	if err := db.Model(&domain.Item{}).Where("id = ?", "rep-1").
		Update("list_id", "list-1").Error; err != nil {
		t.Fatal(err)
	}
	cards, err := repo.Board("list-1")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cards {
		if c.ID == "rep-1" {
			t.Error("a channel item must not be draggable on a task board yet — the report path still owns it")
		}
	}
	open, err := repo.ListOpen([]string{"org-1"}, false, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range open {
		if o.ID == "rep-1" {
			t.Error("nor on the pending dashboard: it is a client's ticket, not our line item")
		}
	}
}

// Comments and attachments, after the move.
//
// This test exists because they were the part the cutover missed. Every read
// still asked for a column called task_id, and the board's counting queries
// threw the error away — so every card came back saying it had no comments, with
// a 200 and no sign anything was wrong. A wrong answer served confidently is the
// failure mode this codebase keeps having to relearn.
func TestCommentsAndAttachmentsSurviveTheMove(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	// Reading a thread.
	comments, err := repo.Comments("task-done")
	if err != nil {
		t.Fatalf("reading comments: %v", err)
	}
	if len(comments) != 2 {
		t.Fatalf("expected the two migrated comments, got %d", len(comments))
	}

	// Adding one, the way the service does.
	fresh := &domain.ItemComment{
		ItemID: "task-done", Kind: domain.CommentKindUser,
		Visibility: domain.VisibilityInternal, Body: "otra nota",
	}
	fresh.ID = "cmt-new"
	if err := repo.CreateComment(fresh); err != nil {
		t.Fatal(err)
	}

	// Attachments, both scopes.
	all, err := repo.Attachments("task-done", nil)
	if err != nil {
		t.Fatalf("reading attachments: %v", err)
	}
	if len(all) != 1 {
		t.Errorf("expected the migrated attachment, got %d", len(all))
	}

	// And the counts the board puts on a card. These are what silently read zero.
	cards, err := repo.Board("list-1")
	if err != nil {
		t.Fatal(err)
	}
	var card *domain.TaskCard
	for i := range cards {
		if cards[i].ID == "task-done" {
			card = &cards[i]
		}
	}
	if card == nil {
		t.Fatal("the task is missing from its own board")
	}
	if card.CommentCount != 3 {
		t.Errorf("the card should count its three comments, got %d", card.CommentCount)
	}
	if card.AttachmentCount != 1 {
		t.Errorf("and its one attachment, got %d", card.AttachmentCount)
	}
}

// Deleting a task hides what was written on it rather than destroying it.
func TestDeletingATaskHidesItsThread(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	if err := repo.DeleteTask("task-done"); err != nil {
		t.Fatal(err)
	}
	var visible int64
	db.Model(&domain.ItemComment{}).Where("item_id = ?", "task-done").Count(&visible)
	if visible != 0 {
		t.Error("its comments should be out of sight")
	}
	var kept int64
	db.Unscoped().Model(&domain.ItemComment{}).
		Where("item_id = ? AND deleted_at IS NOT NULL", "task-done").Count(&kept)
	if kept == 0 {
		t.Error("and still on record — the old behaviour destroyed them")
	}
}

// Raising work in a list that belongs to a client.
//
// The rule the owner chose: what the team is working on should be visible to
// them, and keeping something private is a decision made on purpose. So the
// default is visible — and visible is expensive in a way that is easy to miss.
// It spends one of that client's folio numbers, forever, and puts the item on
// their board.
func TestWorkRaisedInAClientsListIsVisibleByDefault(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	// Default: no choice expressed.
	visible := &domain.Task{ListID: "list-1", OrgID: "org-1", Title: "lo estamos arreglando",
		Status: domain.ReportPending, ProjectID: "proj-1"}
	if err := repo.CreateTask(visible, "space-1"); err != nil {
		t.Fatal(err)
	}
	if !visible.IsChannel() {
		t.Fatal("work in a bound list should reach the client by default")
	}
	// Its number comes from the client's sequence, because that number is the
	// name they will quote back. The seeded report is 7, so this is 8 — not 4,
	// which is where the space's own numbering was.
	if visible.Seq != 8 {
		t.Errorf("a client-visible item takes the next folio of their project: want 8, got %d", visible.Seq)
	}

	// And the opposite choice keeps it to us.
	private := &domain.Task{ListID: "list-1", OrgID: "org-1", Title: "hablar del contrato",
		Status: domain.ReportPending}
	if err := repo.CreateTask(private, "space-1"); err != nil {
		t.Fatal(err)
	}
	if private.IsChannel() {
		t.Fatal("an item marked internal must not reach the client")
	}
	if private.Seq == visible.Seq {
		t.Error("the two numbering scopes must not collide")
	}

	// The client's own view lists one and not the other.
	rr := NewReportRepository(db)
	list, err := rr.List([]string{"org-1"}, domain.ReportListQuery{ProjectID: "proj-1", Limit: 50}, false)
	if err != nil {
		t.Fatal(err)
	}
	var sawVisible, sawPrivate bool
	for _, it := range list.Items {
		if it.ID == visible.ID {
			sawVisible = true
		}
		if it.ID == private.ID {
			sawPrivate = true
		}
	}
	if !sawVisible {
		t.Error("the visible item should be on the client's board")
	}
	if sawPrivate {
		t.Error("the internal one must not be — this is the leak the choice exists to prevent")
	}
}

// A subtask of a client-visible item stays ours.
//
// Inheriting the channel would spend one of their numbers on a checklist line
// and show it on their board as a ticket of its own.
func TestASubtaskOfAVisibleItemStaysInternal(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)

	parent := &domain.Task{ListID: "list-1", OrgID: "org-1", Title: "el trabajo visible",
		Status: domain.ReportPending, ProjectID: "proj-1"}
	if err := repo.CreateTask(parent, "space-1"); err != nil {
		t.Fatal(err)
	}
	pid := parent.ID
	child := &domain.Task{ListID: "list-1", OrgID: "org-1", Title: "un paso interno",
		Status: domain.ReportPending, ParentID: &pid}
	if err := repo.CreateTask(child, "space-1"); err != nil {
		t.Fatal(err)
	}
	if child.IsChannel() {
		t.Error("a subtask must not become a ticket on the client's board")
	}
}

// The choice, through the service — which is where the default lives and where
// the client gets told.
func TestTheChoiceAtCreationTime(t *testing.T) {
	db, cleanup := itemMigrationDB(t)
	defer cleanup()
	seedOldWorld(t, db)
	migrateItems(db)
	repo := NewTaskRepository(db)
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	// Unbound lists are unaffected: asking for "public" where there is no channel
	// cannot invent one.
	if err := repo.BindListToChannel("list-1", ""); err != nil {
		t.Fatal(err)
	}
	if ch, _ := repo.EffectiveChannel("list-1"); ch != "" {
		t.Fatalf("precondition failed: list-1 still reaches %q", ch)
	}
}
