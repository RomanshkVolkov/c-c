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

// Folders that hold folders, and the one way that goes wrong.

// The guard that matters: a folder must not end up inside itself.
//
// This is not a tidy-input check. The navigator is built by walking down from
// the space, so a ring is reachable from nowhere: the folder and everything
// under it stop being drawn while every row is still sitting in the database.
// No error, no empty state, just work that disappeared.
func TestAFolderCannotBeMovedInsideItself(t *testing.T) {
	db, cleanup := treeDB(t)
	defer cleanup()
	svc := treeSvc(db)

	// Directly: "put A inside A".
	err := svc.MoveFolder("fo-a", domain.MoveNodeRequest{FolderID: ptr("fo-a")})
	if err != ErrFolderCycle {
		t.Errorf("moving a folder into itself → %v, want a refusal", err)
	}

	// And through a chain: B already hangs off A, so A inside B closes a ring.
	if err := svc.MoveFolder("fo-b", domain.MoveNodeRequest{FolderID: ptr("fo-a")}); err != nil {
		t.Fatalf("nesting B under A should be allowed: %v", err)
	}
	if err := svc.MoveFolder("fo-a", domain.MoveNodeRequest{FolderID: ptr("fo-b")}); err != ErrFolderCycle {
		t.Errorf("moving a folder under its own descendant → %v, want a refusal", err)
	}
}

// Nesting one folder in another is allowed, and the tree comes back nested.
func TestANestedFolderComesBackInsideItsParent(t *testing.T) {
	db, cleanup := treeDB(t)
	defer cleanup()
	svc := treeSvc(db)

	if err := svc.MoveFolder("fo-b", domain.MoveNodeRequest{FolderID: ptr("fo-a")}); err != nil {
		t.Fatal(err)
	}
	tree, err := svc.Tree([]string{"org-1"}, false, "org-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tree) != 1 {
		t.Fatalf("expected one space, got %d", len(tree))
	}
	// B is no longer a child of the space…
	if len(tree[0].Folders) != 1 || tree[0].Folders[0].ID != "fo-a" {
		t.Fatalf("the space should show only A at its top level: %+v", tree[0].Folders)
	}
	// …it is inside A.
	if len(tree[0].Folders[0].Folders) != 1 || tree[0].Folders[0].Folders[0].ID != "fo-b" {
		t.Errorf("B should hang off A: %+v", tree[0].Folders[0])
	}
}

// Taking a folder back out to the space is the same move with no parent.
func TestAFolderCanComeBackOutToTheSpace(t *testing.T) {
	db, cleanup := treeDB(t)
	defer cleanup()
	svc := treeSvc(db)

	if err := svc.MoveFolder("fo-b", domain.MoveNodeRequest{FolderID: ptr("fo-a")}); err != nil {
		t.Fatal(err)
	}
	if err := svc.MoveFolder("fo-b", domain.MoveNodeRequest{FolderID: nil}); err != nil {
		t.Fatal(err)
	}
	tree, _ := svc.Tree([]string{"org-1"}, false, "org-1")
	if len(tree[0].Folders) != 2 {
		t.Errorf("both folders should be back at the top: %+v", tree[0].Folders)
	}
}

// Reordering writes one row.
//
// The whole reason this module orders with fractional ranks: a numeric position
// would renumber every sibling after the one that moved, which is N writes and
// scrambles the order when two people drag at once.
func TestReorderingTouchesOneRowAndNotItsSiblings(t *testing.T) {
	db, cleanup := treeDB(t)
	defer cleanup()
	svc := treeSvc(db)

	antes := map[string]string{}
	var folders []domain.TaskFolder
	db.Where("space_id = ?", "space-1").Find(&folders)
	for _, f := range folders {
		antes[f.ID] = f.Rank
	}

	// Put A after B — one drag, the smallest real move there is.
	if err := svc.MoveFolder("fo-a", domain.MoveNodeRequest{AfterID: "fo-b"}); err != nil {
		t.Fatal(err)
	}

	var despues []domain.TaskFolder
	db.Where("space_id = ?", "space-1").Find(&despues)
	cambiadas := []string{}
	for _, f := range despues {
		if antes[f.ID] != f.Rank {
			cambiadas = append(cambiadas, f.ID)
		}
	}
	if len(cambiadas) != 1 || cambiadas[0] != "fo-a" {
		t.Errorf("only the moved folder should change rank, got %v", cambiadas)
	}
	// And it really did end up after B.
	var a, b domain.TaskFolder
	db.First(&a, "id = ?", "fo-a")
	db.First(&b, "id = ?", "fo-b")
	if !(a.Rank > b.Rank) {
		t.Errorf("A should sort after B: %q vs %q", a.Rank, b.Rank)
	}
}

func ptr(s string) *string { return &s }

func treeSvc(db *gorm.DB) *TaskService {
	return NewTaskService(
		repository.NewTaskRepository(db),
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		nil,
	)
}

func treeDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_task_tree"
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
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.Item{},
	); err != nil {
		t.Fatal(err)
	}
	org := &domain.Organization{Name: "Árbol", Slug: "arbol"}
	org.ID = "org-1"
	space := &domain.TaskSpace{OrgID: "org-1", Name: "Espacio", Rank: "U"}
	space.ID = "space-1"
	a := &domain.TaskFolder{SpaceID: "space-1", Name: "A", Rank: "U"}
	a.ID = "fo-a"
	b := &domain.TaskFolder{SpaceID: "space-1", Name: "B", Rank: "V"}
	b.ID = "fo-b"
	for _, m := range []any{org, space, a, b} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

// Sorting a container alphabetically, and the one thing it must not do.
//
// Folders keep sitting above lists. That is how the navigator draws them, and a
// sort that interleaved the two kinds would look to a person like the tree had
// scrambled itself rather than tidied up.
func TestSortingPutsFoldersFirstAndThenNames(t *testing.T) {
	db, cleanup := treeDB(t)
	defer cleanup()
	svc := treeSvc(db)

	// Names deliberately out of order, and a list whose name sorts before both
	// folders — it must still end up below them.
	db.Model(&domain.TaskFolder{}).Where("id = ?", "fo-a").Update("name", "Zeta")
	db.Model(&domain.TaskFolder{}).Where("id = ?", "fo-b").Update("name", "alfa")
	lista := &domain.TaskList{SpaceID: "space-1", Name: "Abeja", Rank: "A"}
	lista.ID = "li-x"
	if err := db.Create(lista).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.SortSpace("space-1"); err != nil {
		t.Fatal(err)
	}
	// Asserted on the ranks and not on the tree response: that one returns
	// folders and lists in separate fields, so reading it back would show them
	// grouped whatever the sort did — a test that cannot fail on the thing it
	// claims to check.
	var folders []domain.TaskFolder
	db.Where("space_id = ?", "space-1").Order("rank ASC").Find(&folders)
	var lists []domain.TaskList
	db.Where("space_id = ?", "space-1").Order("rank ASC").Find(&lists)

	// Case-insensitive, or "Zeta" would sort before "alfa" on raw bytes.
	if len(folders) != 2 || folders[0].Name != "alfa" || folders[1].Name != "Zeta" {
		t.Errorf("folders = %v, want [alfa Zeta]", nombresDe(folders))
	}
	// And every list ranks below every folder, which is what keeps the drawn
	// tree from looking like it scrambled itself.
	for _, l := range lists {
		for _, f := range folders {
			if l.Rank <= f.Rank {
				t.Errorf("list %q (%s) should rank after folder %q (%s)", l.Name, l.Rank, f.Name, f.Rank)
			}
		}
	}
}

func nombresDe(fs []domain.TaskFolder) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.Name
	}
	return out
}
