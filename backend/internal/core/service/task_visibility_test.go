package service

import (
	"fmt"
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
	if !silent.IsChannel() {
		t.Error("saying nothing must mean the client can see it — that is the whole point of the default")
	}

	// Asked for public → same.
	open, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "explícitamente visible", Visibility: domain.VisibilityPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !open.IsChannel() {
		t.Error("asking for public in a bound list must reach the client")
	}

	// Asked for internal → kept to us.
	private, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "esto no lo enseñamos", Visibility: domain.VisibilityInternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if private.IsChannel() {
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
	if child.IsChannel() {
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
	if got.IsChannel() {
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
		&domain.Organization{}, &domain.ReportProject{},
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
