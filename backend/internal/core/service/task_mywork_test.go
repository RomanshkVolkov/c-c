package service

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// "My work": the four questions the list has to be able to answer.

// Assigned to me has to mean either kind of assignment.
//
// Responsibility lives in two places: a column for the one person a tenant is
// shown, and a table for everybody else on it. A filter that read only one
// would silently drop half of somebody's work — and it would look like the
// tasks were fine, just not theirs.
func TestAssignedToMeCountsBothKindsOfAssignment(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	got, err := svc.ListOpen([]string{"org-1"}, false, "org-1", 0,
		domain.OpenTaskFilter{AssigneeID: "u-ana"})
	if err != nil {
		t.Fatal(err)
	}
	ids := idsDe(got)
	if !ids["it-columna"] {
		t.Error("a task assigned through the column is mine")
	}
	if !ids["it-tabla"] {
		t.Error("a task assigned through the table is mine too")
	}
	if ids["it-ajena"] {
		t.Error("somebody else's task is not mine")
	}
}

func TestRaisedByMeAndFollowedByMeAreDifferentQuestions(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	mias, _ := svc.ListOpen([]string{"org-1"}, false, "org-1", 0,
		domain.OpenTaskFilter{CreatorID: "u-ana"})
	if !idsDe(mias)["it-creada"] {
		t.Error("a task I raised should come back under creator")
	}
	if idsDe(mias)["it-ajena"] {
		t.Error("a task somebody else raised should not")
	}

	// Following is not assignment and not authorship: it is the only way to
	// keep an eye on work without taking it.
	if err := svc.Watch("it-ajena", "u-ana"); err != nil {
		t.Fatal(err)
	}
	sigo, _ := svc.ListOpen([]string{"org-1"}, false, "org-1", 0,
		domain.OpenTaskFilter{WatcherID: "u-ana"})
	if !idsDe(sigo)["it-ajena"] {
		t.Error("a task I follow should come back under watcher")
	}
	if idsDe(sigo)["it-creada"] {
		t.Error("raising something is not following it")
	}
}

// Following twice is following once, and unfollowing undoes it.
func TestFollowingIsIdempotentAndReversible(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	for i := 0; i < 2; i++ {
		if err := svc.Watch("it-creada", "u-ana"); err != nil {
			t.Fatalf("following again must not be an error: %v", err)
		}
	}
	quienes, _ := svc.Watchers("it-creada")
	if len(quienes) != 1 {
		t.Errorf("two clicks, one follower, got %v", quienes)
	}
	if err := svc.Unwatch("it-creada", "u-ana"); err != nil {
		t.Fatal(err)
	}
	quienes, _ = svc.Watchers("it-creada")
	if len(quienes) != 0 {
		t.Errorf("unfollowing should leave nobody, got %v", quienes)
	}
}

// Closed work stays out unless it is asked for: "what is pending" is the
// question the list exists to answer.
func TestClosedWorkIsHiddenUnlessAskedFor(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	abiertas, _ := svc.ListOpen([]string{"org-1"}, false, "org-1", 0, domain.OpenTaskFilter{})
	if idsDe(abiertas)["it-cerrada"] {
		t.Error("closed work should not be in the pending list")
	}
	todas, _ := svc.ListOpen([]string{"org-1"}, false, "org-1", 0,
		domain.OpenTaskFilter{IncludeClosed: true})
	if !idsDe(todas)["it-cerrada"] {
		t.Error("asked for explicitly, it should come back")
	}
}

// Client-facing work is a different list, not a filter people forget to set.
//
// The team's board deliberately leaves out what came in through a channel: a
// tenant's tickets have their own screen, and mixing them in would make "what
// is pending" mean two different things at once. Asking for them is explicit.
func TestClientWorkIsItsOwnQuestion(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	deCliente := &domain.Item{
		OrgID: "org-1", ListID: "list-1", Title: "De un cliente",
		CreatedByID: "u-otro", Status: domain.ReportPending, ProjectID: "proj-1",
	}
	deCliente.ID = "it-cliente"
	if err := db.Create(deCliente).Error; err != nil {
		t.Fatal(err)
	}

	nuestras, _ := svc.ListOpen([]string{"org-1"}, false, "org-1", 0, domain.OpenTaskFilter{})
	if idsDe(nuestras)["it-cliente"] {
		t.Error("client work should stay out of the team's own list")
	}
	suyas, _ := svc.ListOpen([]string{"org-1"}, false, "org-1", 0,
		domain.OpenTaskFilter{Origin: domain.OriginClients})
	if !idsDe(suyas)["it-cliente"] {
		t.Error("asked for by origin, it should come back")
	}
	if idsDe(suyas)["it-creada"] {
		t.Error("and our own work should not be in that answer")
	}
}

// A card says what you would otherwise open it to find out.
//
// Two grouped queries, not two per row: the list is up to two hundred cards and
// a query apiece is the difference between a screen and a wait.
func TestACardCarriesItsProgressAndWhoseItIs(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	// Dos subtareas de it-creada, una terminada.
	for i, estado := range []domain.ReportStatus{domain.ReportPending, domain.ReportStatus("closed")} {
		padre := "it-creada"
		sub := &domain.Item{
			OrgID: "org-1", ListID: "list-1", Title: fmt.Sprintf("sub %d", i),
			ParentID: &padre, Status: estado,
		}
		sub.ID = fmt.Sprintf("it-sub-%d", i)
		if err := db.Create(sub).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Y una responsable principal.
	u := &domain.User{Username: "ana"}
	u.ID = "u-ana"
	if err := db.Create(u).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.ItemAssignee{ItemID: "it-creada", UserID: "u-ana", Primary: true}).Error; err != nil {
		t.Fatal(err)
	}

	got, err := svc.ListOpen([]string{"org-1"}, false, "org-1", 0, domain.OpenTaskFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var card *domain.OpenTask
	for i := range got {
		if got[i].ID == "it-creada" {
			card = &got[i]
		}
	}
	if card == nil {
		t.Fatal("the task should be in the list")
	}
	if card.SubtasksDone != 1 || card.SubtasksTotal != 2 {
		t.Errorf("progress = %d/%d, want 1/2", card.SubtasksDone, card.SubtasksTotal)
	}
	if card.Assignee != "ana" {
		t.Errorf("assignee = %q, want ana", card.Assignee)
	}

	// Y una sin nada no inventa nada.
	for i := range got {
		if got[i].ID == "it-ajena" && (got[i].SubtasksTotal != 0 || got[i].Assignee != "") {
			t.Errorf("a bare task should stay bare: %+v", got[i])
		}
	}
}

func idsDe(ts []domain.OpenTask) map[string]bool {
	out := map[string]bool{}
	for _, t := range ts {
		out[t.ID] = true
	}
	return out
}

func myWorkSvc(db *gorm.DB) *TaskService {
	return NewTaskService(
		repository.NewTaskRepository(db),
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		nil,
	)
}

func myWorkDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_my_work"
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
		&domain.Organization{}, &domain.TaskSpace{}, &domain.TaskList{},
		&domain.Item{}, &domain.ItemAssignee{}, &domain.ItemWatcher{}, &domain.User{},
	); err != nil {
		t.Fatal(err)
	}
	org := &domain.Organization{Name: "Uno", Slug: "uno"}
	org.ID = "org-1"
	sp := &domain.TaskSpace{OrgID: "org-1", Name: "Espacio", Rank: "U"}
	sp.ID = "space-1"
	li := &domain.TaskList{SpaceID: "space-1", Name: "Lista", Rank: "U"}
	li.ID = "list-1"
	for _, m := range []any{org, sp, li} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	ana := "u-ana"
	tareas := []struct {
		id, titulo, creador string
		asignada            *string
		estado              domain.ReportStatus
	}{
		{"it-columna", "Por columna", "u-otro", &ana, domain.ReportPending},
		{"it-tabla", "Por tabla", "u-otro", nil, domain.ReportPending},
		{"it-ajena", "De otro", "u-otro", nil, domain.ReportPending},
		{"it-creada", "La levanté yo", "u-ana", nil, domain.ReportPending},
		{"it-cerrada", "Ya está", "u-ana", &ana, domain.ReportStatus("closed")},
	}
	for _, x := range tareas {
		it := &domain.Item{
			OrgID: "org-1", ListID: "list-1", Title: x.titulo,
			CreatedByID: x.creador, AssigneeUserID: x.asignada, Status: x.estado,
		}
		it.ID = x.id
		if err := db.Create(it).Error; err != nil {
			t.Fatal(err)
		}
	}
	// La de "por tabla" se asigna por la tabla, que es el otro camino.
	if err := db.Create(&domain.ItemAssignee{ItemID: "it-tabla", UserID: "u-ana"}).Error; err != nil {
		t.Fatal(err)
	}
	_ = time.Now
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
