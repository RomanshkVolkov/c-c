package repository_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// What the dashboard's pending list rests on, checked against a real Postgres
// because every interesting part of ListOpen is SQL: the join across lists, the
// `kind` filter, and an ORDER BY that has to spell out a priority order the
// database can't infer from the stored strings.
//
// Skips when there's no database, so `go test ./...` stays green without one.
func TestListOpenSkipsFinishedSubtasksAndArchived(t *testing.T) {
	db, cleanup := openTaskDB(t)
	defer cleanup()

	const org, other = "org-open", "org-other"
	space := &domain.TaskSpace{OrgID: org, Name: "Producto"}
	space.ID = "sp-1"
	list := &domain.TaskList{SpaceID: space.ID, Name: "Backlog"}
	list.ID = "li-1"
	todo := &domain.TaskStatus{ListID: list.ID, Name: "To do", Kind: domain.StatusKindOpen}
	todo.ID = "st-todo"
	shipped := &domain.TaskStatus{ListID: list.ID, Name: "Shipped", Kind: domain.StatusKindDone}
	shipped.ID = "st-done"
	for _, m := range []any{space, list, todo, shipped} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}

	soon := time.Now().Add(24 * time.Hour)
	later := time.Now().Add(240 * time.Hour)
	gone := time.Now()
	mk := func(id, title string, p domain.TaskPriority, status string, due *time.Time, mutate func(*domain.Task)) {
		task := &domain.Task{
			ListID: list.ID, StatusID: status, OrgID: org, Seq: 1,
			Title: title, Priority: p, DueAt: due,
		}
		task.ID = id
		if mutate != nil {
			mutate(task)
		}
		if err := db.Create(task).Error; err != nil {
			t.Fatal(err)
		}
	}

	mk("t-normal", "normal sin fecha", domain.PriorityNormal, todo.ID, nil, nil)
	mk("t-urgent", "urgente", domain.PriorityUrgent, todo.ID, &later, nil)
	mk("t-normal-soon", "normal que vence pronto", domain.PriorityNormal, todo.ID, &soon, nil)
	// None of these three may appear.
	mk("t-done", "terminada", domain.PriorityUrgent, shipped.ID, nil, nil)
	mk("t-archived", "archivada", domain.PriorityUrgent, todo.ID, nil, func(x *domain.Task) {
		x.ArchivedAt = &gone
	})
	mk("t-subtask", "subtarea", domain.PriorityUrgent, todo.ID, nil, func(x *domain.Task) {
		parent := "t-normal"
		x.ParentID = &parent
	})
	// Another org's work, to prove the scoping is a filter and not a hope.
	otherSpace := &domain.TaskSpace{OrgID: other, Name: "Ajeno"}
	otherSpace.ID = "sp-2"
	otherList := &domain.TaskList{SpaceID: otherSpace.ID, Name: "Suyo"}
	otherList.ID = "li-2"
	otherStatus := &domain.TaskStatus{ListID: otherList.ID, Name: "To do", Kind: domain.StatusKindOpen}
	otherStatus.ID = "st-other"
	foreign := &domain.Task{
		ListID: otherList.ID, StatusID: otherStatus.ID, OrgID: other, Seq: 1,
		Title: "de otra org", Priority: domain.PriorityUrgent,
	}
	foreign.ID = "t-foreign"
	for _, m := range []any{otherSpace, otherList, otherStatus, foreign} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}

	repo := repository.NewTaskRepository(db)

	got, err := repo.ListOpen([]string{org}, false, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(got))
	for i, task := range got {
		ids[i] = task.ID
	}
	// Urgent first; then the two normals, soonest due date before no date at all.
	want := []string{"t-urgent", "t-normal-soon", "t-normal"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("wrong set or order\n got: %v\nwant: %v", ids, want)
	}
	if got[0].ListName != "Backlog" || got[0].SpaceName != "Producto" {
		t.Fatalf("a cross-list row has to say where it came from: %+v", got[0])
	}
	if got[0].StatusName != "To do" || got[0].StatusKind != domain.StatusKindOpen {
		t.Fatalf("status not carried through: %+v", got[0])
	}

	// Membership is what scopes it: a caller in neither org sees nothing, and a
	// superadmin narrowing by ?orgId sees only that org.
	if none, err := repo.ListOpen([]string{"org-nobody"}, false, "", 50); err != nil || len(none) != 0 {
		t.Fatalf("a non-member must see nothing, got %d (%v)", len(none), err)
	}
	narrowed, err := repo.ListOpen(nil, true, other, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(narrowed) != 1 || narrowed[0].ID != "t-foreign" {
		t.Fatalf("?orgId must narrow a superadmin to one org, got %+v", narrowed)
	}
}

func openTaskDB(t *testing.T) (*gorm.DB, func()) {
	t.Helper()
	loadEnvFile("../../../.env")
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
	const name = "cac_test_open_tasks"
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
		&domain.TaskSpace{}, &domain.TaskList{}, &domain.TaskStatus{}, &domain.Task{},
	); err != nil {
		t.Fatal(err)
	}
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

// repository.LoadEnv opens "./.env" relative to the working directory, which
// under `go test` is this package's directory rather than the module root.
func loadEnvFile(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if os.Getenv(strings.TrimSpace(k)) == "" {
			os.Setenv(strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`))
		}
	}
}
