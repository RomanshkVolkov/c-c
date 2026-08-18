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

// Copying a folder, and taking one somewhere else.

// A copy brings the shape and leaves the work.
//
// Duplicating is how a folder gets reused as a template. Carrying the tasks
// across would mint fresh folios for items that already exist and leave two
// copies of the same job for somebody to reconcile later — so the empty shape
// is the useful half, and this is the test that says so out loud.
func TestDuplicatingAFolderCopiesItsShapeAndNotItsWork(t *testing.T) {
	db, cleanup := branchDB(t)
	defer cleanup()
	svc := branchSvc(db)

	copia, err := svc.DuplicateFolder("fo-padre", "Copia")
	if err != nil {
		t.Fatal(err)
	}
	if copia.ID == "fo-padre" {
		t.Fatal("the copy must be a different folder")
	}

	tree, err := svc.Tree([]string{"org-1"}, false, "org-1")
	if err != nil {
		t.Fatal(err)
	}
	var nuevo *domain.FolderTree
	for i := range tree {
		for j := range tree[i].Folders {
			if tree[i].Folders[j].ID == copia.ID {
				nuevo = &tree[i].Folders[j]
			}
		}
	}
	if nuevo == nil {
		t.Fatal("the copy is not in the tree")
	}
	if nuevo.Name != "Copia" {
		t.Errorf("the copy should take the given name, got %q", nuevo.Name)
	}
	// The nested folder came along…
	if len(nuevo.Folders) != 1 || nuevo.Folders[0].ID == "fo-hijo" {
		t.Fatalf("the nested folder should be copied, not shared: %+v", nuevo.Folders)
	}
	// …and so did the list inside it, as a new one.
	if len(nuevo.Folders[0].Lists) != 1 || nuevo.Folders[0].Lists[0].ID == "li-1" {
		t.Fatalf("the list should be copied, not shared: %+v", nuevo.Folders[0].Lists)
	}
	// But not a single task.
	var tareas int64
	db.Model(&domain.Item{}).Where("list_id = ?", nuevo.Folders[0].Lists[0].ID).Count(&tareas)
	if tareas != 0 {
		t.Errorf("a copied list starts empty, found %d tasks", tareas)
	}
	// And the copy is not bound to anybody's channel.
	if nuevo.Folders[0].Lists[0].ProjectID != "" {
		t.Errorf("a copy must not carry the original's binding, got %q", nuevo.Folders[0].Lists[0].ProjectID)
	}
}

// The fence: work does not cross between organizations.
func TestABranchCannotBeMovedIntoAnotherOrganization(t *testing.T) {
	db, cleanup := branchDB(t)
	defer cleanup()
	svc := branchSvc(db)

	if err := svc.MoveFolderToSpace("fo-padre", "space-otra"); err != ErrDifferentOrganization {
		t.Errorf("moving a folder to another org's space → %v, want a refusal", err)
	}
	if err := svc.MoveListToSpace("li-1", "space-otra"); err != ErrDifferentOrganization {
		t.Errorf("moving a list to another org's space → %v, want a refusal", err)
	}
}

// Moving a list must not change who can read it.
//
// A list with no binding of its own shows whatever its space says. Moved from a
// bound space into an unbound one it would quietly stop being visible to the
// client who was following it — or, worse, into a space bound to somebody else
// it would start being visible to the wrong one. Neither is something a person
// tidying up their tree intends.
func TestMovingAListKeepsWhoCanSeeIt(t *testing.T) {
	db, cleanup := branchDB(t)
	defer cleanup()
	svc := branchSvc(db)

	// `li-suelta` sits directly under the bound space and inherits its channel.
	antes, err := svc.Tree([]string{"org-1"}, false, "org-1")
	if err != nil {
		t.Fatal(err)
	}
	var visibleAntes string
	for _, l := range antes[0].Lists {
		if l.ID == "li-suelta" {
			visibleAntes = l.ProjectID
		}
	}
	if visibleAntes == "" {
		t.Fatal("the fixture should start with an inherited channel")
	}

	if err := svc.MoveListToSpace("li-suelta", "space-2"); err != nil {
		t.Fatal(err)
	}

	var l domain.TaskList
	db.First(&l, "id = ?", "li-suelta")
	if l.ProjectID == nil || *l.ProjectID != visibleAntes {
		t.Errorf("the list should carry its channel across, got %v want %q", l.ProjectID, visibleAntes)
	}
}

func branchSvc(db *gorm.DB) *TaskService {
	return NewTaskService(
		repository.NewTaskRepository(db),
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		nil,
	)
}

func branchDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_task_branch"
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
		&domain.Organization{}, &domain.ReportProject{}, &domain.User{}, &domain.OrgMembership{},
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.TaskStatus{},
		&domain.Item{},
	); err != nil {
		t.Fatal(err)
	}

	proj := "proj-1"
	filas := []any{}
	org1 := &domain.Organization{Name: "Uno", Slug: "uno"}
	org1.ID = "org-1"
	org2 := &domain.Organization{Name: "Otra", Slug: "otra"}
	org2.ID = "org-2"
	p := &domain.ReportProject{OrgID: "org-1", Name: "Cliente", Slug: "cliente", IngestKeyHash: []byte("h")}
	p.ID = proj
	// space-1 is bound to a client, which is what makes the visibility test real.
	sp1 := &domain.TaskSpace{OrgID: "org-1", Name: "Uno", Rank: "U", ProjectID: &proj}
	sp1.ID = "space-1"
	sp2 := &domain.TaskSpace{OrgID: "org-1", Name: "Dos", Rank: "V"}
	sp2.ID = "space-2"
	spOtra := &domain.TaskSpace{OrgID: "org-2", Name: "Ajeno", Rank: "U"}
	spOtra.ID = "space-otra"
	padre := &domain.TaskFolder{SpaceID: "space-2", Name: "Padre", Rank: "U"}
	padre.ID = "fo-padre"
	hijoID := "fo-padre"
	hijo := &domain.TaskFolder{SpaceID: "space-2", ParentFolderID: &hijoID, Name: "Hijo", Rank: "U"}
	hijo.ID = "fo-hijo"
	foHijo := "fo-hijo"
	// Con atado propio: es lo que la copia no debe llevarse.
	li1 := &domain.TaskList{SpaceID: "space-2", FolderID: &foHijo, Name: "Lista", Rank: "U", ProjectID: &proj}
	li1.ID = "li-1"
	suelta := &domain.TaskList{SpaceID: "space-1", Name: "Suelta", Rank: "V"}
	suelta.ID = "li-suelta"
	filas = append(filas, org1, org2, p, sp1, sp2, spOtra, padre, hijo, li1, suelta)
	for _, m := range filas {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	// One task, so "the copy brings no work" is a claim with something to fail on.
	tarea := &domain.Item{ListID: "li-1", Title: "Trabajo"}
	tarea.ID = "it-1"
	if err := db.Create(tarea).Error; err != nil {
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
