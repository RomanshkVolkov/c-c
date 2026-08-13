package service

import (
	"fmt"
	"strings"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// The default, where it is actually decided.
//
// This lives here rather than beside the repository tests because the rule is a
// service rule, and that distinction is not academic: inverting the default
// compiles, passes every repository test, and quietly stops a client from seeing
// what is being done for them. The mutation that flips it has to fail
// *somewhere*, and this is the only place it can.
func TestVisibleIsTheDefaultAndInternalIsAChoice(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	// Nothing said → the client sees it.
	silent, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "sin decir nada"})
	if err != nil {
		t.Fatal(err)
	}
	if !silent.IsVisibleToChannel() {
		t.Error("saying nothing must mean the client can see it — that is the whole point of the default")
	}

	// Asked for public → same.
	open, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "explícitamente visible", Visibility: domain.VisibilityPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !open.IsVisibleToChannel() {
		t.Error("asking for public in a bound list must reach the client")
	}

	// Asked for internal → kept to us.
	private, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "esto no lo enseñamos", Visibility: domain.VisibilityInternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if private.IsVisibleToChannel() {
		t.Error("internal must stay internal — this is the choice the owner asked for")
	}

	// A subtask of a visible item stays ours: inheriting would spend one of the
	// client's folio numbers on a checklist line.
	child, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "un paso", ParentID: silent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.IsVisibleToChannel() {
		t.Error("a subtask must not appear on the client's board as a ticket of its own")
	}
}

// A list nobody's channel points at cannot be made visible by asking.
func TestAskingForPublicWhereThereIsNoChannelChangesNothing(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	got, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "nadie a quien enseñárselo", Visibility: domain.VisibilityPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.IsVisibleToChannel() {
		t.Error("there is no client here; asking must not invent one")
	}
}

func visibilityDB(t *testing.T) (*gorm.DB, func()) {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_task_visibility"
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
		&domain.Organization{}, &domain.ReportProject{}, &domain.User{},
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{},
		&domain.Item{}, &domain.ItemComment{}, &domain.ItemAttachment{},
		&domain.TaskTag{}, &domain.TaskTagLink{}, &domain.TaskAssignee{},
	); err != nil {
		t.Fatal(err)
	}
	org := &domain.Organization{Name: "Vis", Slug: "vis"}
	org.ID = "org-1"
	proj := &domain.ReportProject{OrgID: "org-1", Name: "Cliente", Slug: "cliente", IngestKeyHash: []byte("h")}
	proj.ID = "proj-1"
	space := &domain.TaskSpace{OrgID: "org-1", Name: "Espacio", Rank: "U"}
	space.ID = "space-1"
	list := &domain.TaskList{SpaceID: "space-1", Name: "Lista", Rank: "U"}
	list.ID = "list-1"
	for _, m := range []any{org, proj, space, list} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db, func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

// Publishing to a client is a mistake someone will make, so there has to be a
// way back — and the way back has to be honest about what it can't undo.
func TestAnItemCanBeTakenBackButKeepsItsSpentFolio(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	published, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "publicado sin querer"})
	if err != nil {
		t.Fatal(err)
	}
	if !published.IsVisibleToChannel() {
		t.Fatal("precondition: it should have gone out visible")
	}
	spent := published.Seq

	internal := domain.VisibilityInternal
	if err := svc.UpdateTask(published.ID, domain.UpdateTaskRequest{Visibility: &internal}); err != nil {
		t.Fatal(err)
	}
	after, err := repo.FindTask(published.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Off their board, but still belonging to their channel: that is what keeps
	// the folio spent.
	if after.IsVisibleToChannel() {
		t.Error("it should be off the client's board")
	}
	if !after.IsChannel() {
		t.Error("it must keep the channel, or the next item is handed the same folio")
	}
	if after.Seq != spent {
		t.Errorf("the folio stays spent: the client may have quoted %d, so reusing it "+
			"would make that name mean two things. got %d", spent, after.Seq)
	}

	// And the next thing published does not reuse the gap.
	next, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "el siguiente"})
	if err != nil {
		t.Fatal(err)
	}
	if next.Seq <= spent {
		t.Errorf("numbering must move on: %d came after %d", next.Seq, spent)
	}
}

// And the other direction: an internal item can be handed over deliberately.
func TestAnInternalItemCanBePublishedLater(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	private, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "todavía no", Visibility: domain.VisibilityInternal,
	})
	if err != nil {
		t.Fatal(err)
	}

	public := domain.VisibilityPublic
	if err := svc.UpdateTask(private.ID, domain.UpdateTaskRequest{Visibility: &public}); err != nil {
		t.Fatal(err)
	}
	after, err := repo.FindTask(private.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.IsVisibleToChannel() {
		t.Fatal("it should now be on the client's board")
	}
	if after.Seq == 0 {
		t.Error("and it needs a folio of its own — that number is how the client will refer to it")
	}
}

// Dragging a client's report across a column is triage, and has to leave the
// same trace as doing it from the reports page.
//
// The failure this guards is the quiet one: the card moves, the board looks
// right, and the client is never told. They would be reading a status that
// stopped being true, with nothing anywhere saying so.
func TestDraggingAClientsReportTellsThem(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	reports := repository.NewReportRepository(db)
	svc := NewTaskService(repo, reports, nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "algo que ven"})
	if err != nil {
		t.Fatal(err)
	}

	before, err := reports.ListComments(card.ID, true)
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.MoveTask(card.ID, domain.MoveTaskRequest{
		StatusID: domain.SyntheticStatusID("list-1", domain.ReportInProgress),
	}); err != nil {
		t.Fatal(err)
	}

	after, err := reports.ListComments(card.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before)+1 {
		t.Fatalf("the move should leave a line in the thread: %d comments before, %d after",
			len(before), len(after))
	}
	note := after[len(after)-1]
	if note.Kind != domain.CommentKindSystem {
		t.Errorf("it is a system note, not somebody's words: %q", note.Kind)
	}
	// Public: this is how the reporter learns anything is happening at all.
	if note.Body == "" || !strings.Contains(note.Body, "in_progress") {
		t.Errorf("the note should say where it went, got %q", note.Body)
	}
	visible, err := reports.ListComments(card.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != len(after) {
		t.Error("the client has to be able to read it — an internal status note tells nobody")
	}
}

// Moving an internal card leaves no such trace: there is nobody to tell.
func TestDraggingAnInternalCardTellsNobody(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	reports := repository.NewReportRepository(db)
	svc := NewTaskService(repo, reports, nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "cosa nuestra"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.MoveTask(card.ID, domain.MoveTaskRequest{
		StatusID: domain.SyntheticStatusID("list-1", domain.ReportInProgress),
	}); err != nil {
		t.Fatal(err)
	}
	notes, err := reports.ListComments(card.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 0 {
		t.Errorf("an internal card needs no status note; got %d", len(notes))
	}
}

// Moving a card to another list, which is how a report that landed in the wrong
// place gets tidied up.
func TestACardCanMoveToAnotherList(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	other := &domain.TaskList{SpaceID: "space-2", Name: "Otra", Rank: "U"}
	other.ID = "list-2"
	space2 := &domain.TaskSpace{OrgID: "org-1", Name: "Segundo", Rank: "V"}
	space2.ID = "space-2"
	for _, m := range []any{space2, other} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}

	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "en el sitio equivocado"})
	if err != nil {
		t.Fatal(err)
	}
	dest := "list-2"
	if err := svc.UpdateTask(card.ID, domain.UpdateTaskRequest{ListID: &dest}); err != nil {
		t.Fatal(err)
	}

	moved, err := repo.FindTask(card.ID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.ListID != "list-2" {
		t.Errorf("it should be in the destination list, got %q", moved.ListID)
	}
	// The denormalised space has to travel with it: it scopes internal numbering
	// and keeps the report queries off the task tables, so a stale one puts the
	// card in a space it is not in.
	if moved.SpaceID != "space-2" {
		t.Errorf("space_id should have followed the move, got %q", moved.SpaceID)
	}
	if moved.Rank == "" {
		t.Error("and it needs a place in the destination's order")
	}

	// It shows up on the new board and not the old one.
	cards, err := repo.Board("list-2")
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0].ID != card.ID {
		t.Errorf("the destination board should hold it, got %d cards", len(cards))
	}
	if old, _ := repo.Board("list-1"); len(old) != 0 {
		t.Errorf("it should be gone from the list it left, %d remain", len(old))
	}
}

// And it cannot cross into another organization's tree.
func TestACardCannotMoveToAnotherOrgsList(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	elsewhere := &domain.Organization{Name: "Otra", Slug: "otra"}
	elsewhere.ID = "org-2"
	theirSpace := &domain.TaskSpace{OrgID: "org-2", Name: "Suyo", Rank: "U"}
	theirSpace.ID = "space-theirs"
	theirList := &domain.TaskList{SpaceID: "space-theirs", Name: "Suya", Rank: "U"}
	theirList.ID = "list-theirs"
	for _, m := range []any{elsewhere, theirSpace, theirList} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}

	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "nuestra"})
	if err != nil {
		t.Fatal(err)
	}
	dest := "list-theirs"
	if err := svc.UpdateTask(card.ID, domain.UpdateTaskRequest{ListID: &dest}); err == nil {
		t.Error("moving a card into another organization's tree must be refused")
	}
	after, _ := repo.FindTask(card.ID)
	if after.ListID != "list-1" {
		t.Error("and a refused move must not have moved anything")
	}
}

// The detail speaks the vocabulary the task API promised.
//
// This is the bug that reached a person: the board translated the priority and
// the detail did not, so opening a client's report handed the app `medium` — a
// value its own table had no row for — and reading a field off that undefined
// blanked the screen. Correct in five places and wrong in the one anybody
// actually clicks.
func TestTheDetailAnswersInTheTaskVocabulary(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	// A card carrying the stored spelling, as every migrated report does.
	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "de un reporte"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&domain.Item{}).Where("id = ?", card.ID).
		Update("priority", domain.ItemPriorityMedium).Error; err != nil {
		t.Fatal(err)
	}

	detail, err := svc.Detail(card.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Task.Priority != "normal" {
		t.Errorf("the detail must answer in the vocabulary this API has always used: "+
			"want normal, got %q", detail.Task.Priority)
	}

	// And the board, which already did — so the two never disagree about the
	// same card.
	cards, err := repo.Board("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 {
		t.Fatalf("expected the one card, got %d", len(cards))
	}
	if string(cards[0].Priority) != string(detail.Task.Priority) {
		t.Errorf("board says %q and detail says %q for the same card",
			cards[0].Priority, detail.Task.Priority)
	}
}

// Commenting from the task drawer on something a client can see reaches them.
//
// This is the one that got out: a reply typed into the board's thread was filed
// internal, so the board showed two comments and the client's page showed one.
// Nobody was told, and from either side the thread looked complete.
func TestCommentingOnAClientsCardReachesThem(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	reports := repository.NewReportRepository(db)
	svc := NewTaskService(repo, reports, nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "algo suyo"})
	if err != nil {
		t.Fatal(err)
	}

	// Nothing said: they read it.
	if _, err := svc.AddComment(card.ID, "u-1", "vamos con ello", ""); err != nil {
		t.Fatal(err)
	}
	// Said internal: they don't.
	if _, err := svc.AddComment(card.ID, "u-1", "ojo, se les olvidó pagar", domain.VisibilityInternal); err != nil {
		t.Fatal(err)
	}

	inside, err := reports.ListComments(card.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	outside, err := reports.ListComments(card.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(inside) != 2 {
		t.Fatalf("the team sees both, got %d", len(inside))
	}
	if len(outside) != 1 {
		t.Fatalf("the client sees only the one meant for them, got %d", len(outside))
	}
	if outside[0].Body != "vamos con ello" {
		t.Errorf("the wrong one reached them: %q", outside[0].Body)
	}
}

// On a card no client can see, every comment is internal — including one that
// asks to be public, because there is nobody to show it to.
func TestCommentingOnAnInternalCardStaysInternal(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	reports := repository.NewReportRepository(db)
	svc := NewTaskService(repo, reports, nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}

	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "cosa nuestra"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AddComment(card.ID, "u-1", "una nota", domain.VisibilityPublic); err != nil {
		t.Fatal(err)
	}
	outside, err := reports.ListComments(card.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(outside) != 0 {
		t.Error("there is no client here; asking for public must not invent one")
	}
}

// A deleted comment leaves the thread, and every comment says who reads it.
//
// Both halves of what a person actually hit. Comments became soft-deleted when
// the tables merged and this read kept using a raw table name, which opts out of
// the scope that hides them — so deleting one looked like it had failed, the
// line stayed on screen, and trying again answered "not found" about something
// visibly there.
//
// And the thread said nothing about audience, so a board of replies looked the
// same whether the client could read them or not. The only way to find out was
// to open their side and count.
func TestTheThreadHidesDeletedCommentsAndNamesItsAudience(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}
	card, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "con hilo"})
	if err != nil {
		t.Fatal(err)
	}

	shared, err := svc.AddComment(card.ID, "u-1", "lo ven", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AddComment(card.ID, "u-1", "no lo ven", domain.VisibilityInternal); err != nil {
		t.Fatal(err)
	}
	doomed, err := svc.AddComment(card.ID, "u-1", "esto se va", "")
	if err != nil {
		t.Fatal(err)
	}

	// Each line says its audience, so the drawer can draw the difference.
	thread, err := repo.Comments(card.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(thread) != 3 {
		t.Fatalf("expected three comments, got %d", len(thread))
	}
	seen := map[string]domain.ItemVisibility{}
	for _, c := range thread {
		seen[c.Body] = c.Visibility
	}
	if seen["lo ven"] != domain.VisibilityPublic {
		t.Errorf("a reply the client reads must say so, got %q", seen["lo ven"])
	}
	if seen["no lo ven"] != domain.VisibilityInternal {
		t.Errorf("and an internal note must say that, got %q", seen["no lo ven"])
	}
	_ = shared

	// Deleting removes it from the thread — the failure was that it did not.
	if err := svc.DeleteComment(doomed.ID); err != nil {
		t.Fatal(err)
	}
	after, err := repo.Comments(card.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 {
		t.Fatalf("a deleted comment must leave the thread; %d still there", len(after))
	}
	for _, c := range after {
		if c.ID == doomed.ID {
			t.Error("the deleted comment is still on screen, which is what made deleting look broken")
		}
	}
}
