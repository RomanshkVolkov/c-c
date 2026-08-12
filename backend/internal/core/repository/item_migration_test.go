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

	// ── Assignees ──
	var primary domain.ItemAssignee
	if err := db.First(&primary, "item_id = ?", "rep-1").Error; err != nil {
		t.Fatal(err)
	}
	if !primary.Primary {
		t.Error("a report had exactly one assignee, so it is the primary one — the contract reads a single id")
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
		"assignees":   `SELECT COUNT(*) FROM item_assignees`,
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

	assignee := "u-1"
	proj := &domain.ReportProject{
		OrgID: "org-1", Name: "Acme Support", Slug: "acme",
		IngestKeyHash: []byte("h"), IsActive: true, Platform: "app",
	}
	proj.ID = "proj-1"
	mk(proj)

	rep := &domain.Report{
		ProjectID: "proj-1", Seq: 7, Title: "algo se rompió", Description: "detalle",
		Status: domain.ReportPending, ReporterID: "ext-9", ReporterName: "Quien reporta",
		AssigneeUserID: &assignee,
	}
	rep.ID = "rep-1"
	mk(rep)

	cmt := &domain.ReportComment{ReportID: "rep-1", Body: "respuesta", Kind: domain.CommentKindUser}
	cmt.ID = "cmt-report"
	cmt.AuthorUserID = &assignee
	mk(cmt)

	sys := &domain.ReportComment{ReportID: "rep-1", Body: "status: pending → in_progress", Kind: domain.CommentKindSystem}
	sys.ID = "cmt-system"
	mk(sys)

	gone := &domain.ReportComment{ReportID: "rep-1", Body: "esto se retiró", Kind: domain.CommentKindUser}
	gone.ID = "cmt-withdrawn"
	gone.AuthorUserID = &assignee
	mk(gone)
	if err := db.Delete(&domain.ReportComment{}, "id = ?", "cmt-withdrawn").Error; err != nil {
		t.Fatal(err)
	}

	inComment := "cmt-report"
	img := &domain.ReportImage{ReportID: "rep-1", CommentID: &inComment, Path: "r/one.png", FileName: "one.png"}
	img.ID = "img-1"
	mk(img)

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
	task := &domain.Task{
		ListID: "list-1", StatusID: "st-done", OrgID: "org-1", Seq: 3,
		Title: "ya salió", Priority: domain.TaskPriority("normal"), CompletedAt: &completed,
		CreatedByID: "u-1",
	}
	task.ID = "task-done"
	mk(task)

	tc := &domain.TaskComment{TaskID: "task-done", AuthorUserID: "u-1", Body: "nota del equipo"}
	tc.ID = "cmt-task"
	mk(tc)

	// An author id that was never filled in — on the channel side that shape
	// means "the reporter", so it must not travel as an empty string.
	orphan := &domain.TaskComment{TaskID: "task-done", AuthorUserID: "", Body: "sin autor"}
	orphan.ID = "cmt-task-noauthor"
	mk(orphan)

	att := &domain.TaskAttachment{
		TaskID: "task-done", Path: "t/spec.pdf", FileName: "spec.pdf",
		URL: domain.AttachmentRef("task-done", "att-1"), ContentType: "application/pdf", Bytes: 10,
	}
	att.ID = "att-1"
	mk(att)

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
		&domain.ReportProject{}, &domain.Report{}, &domain.ReportComment{}, &domain.ReportImage{},
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.TaskStatus{},
		&domain.Task{}, &domain.TaskComment{}, &domain.TaskAttachment{}, &domain.TaskAssignee{},
		&domain.TaskTag{}, &domain.TaskTagLink{},
		&domain.Item{}, &domain.ItemComment{}, &domain.ItemAttachment{}, &domain.ItemAssignee{},
	); err != nil {
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

	stray := &domain.Task{
		ListID: "list-vanished", StatusID: "st-gone", OrgID: "org-1", Seq: 99,
		Title: "de una lista borrada",
	}
	stray.ID = "task-orphan"
	if err := db.Create(stray).Error; err != nil {
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
	// MAX(seq) produced after a withdrawal.
	twin := &domain.Report{
		ProjectID: "proj-1", Seq: 7, Title: "el gemelo", Status: domain.ReportPending,
	}
	twin.ID = "rep-twin"
	if err := db.Create(twin).Error; err != nil {
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
