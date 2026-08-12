package repository_test

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// The folio (`slug-7`) is the public name of a report: it's what a reporter
// quotes, what a tenant stores, and what an email says. Two reports sharing one
// is not a cosmetic clash — it makes the name ambiguous for everyone outside,
// permanently, and nothing in the system complains.
//
// It happens because the next seq is `MAX(seq) + 1` read through GORM, whose
// soft-delete scope hides deleted rows: withdraw the newest report of a project
// and its number is handed out again.

func TestASeqIsNeverHandedOutTwiceEvenAfterADelete(t *testing.T) {
	db, cleanup := reportSeqDB(t)
	defer cleanup()
	repo := repository.NewReportRepository(db)

	project := &domain.ReportProject{OrgID: "org", Name: "acme", Slug: "acme", IngestKeyHash: []byte("h")}
	project.ID = "proj"
	if err := db.Create(project).Error; err != nil {
		t.Fatal(err)
	}

	create := func(title string) *domain.Report {
		rep := &domain.Report{ProjectID: "proj", Title: title, Status: domain.ReportPending}
		if err := repo.CreateWithSeq(rep); err != nil {
			t.Fatalf("creating %q: %v", title, err)
		}
		return rep
	}

	first := create("el primero")
	if first.Seq != 1 {
		t.Fatalf("first report should be seq 1, got %d", first.Seq)
	}

	// Soft-delete it: the row stays, so its number stays taken.
	if err := db.Delete(&domain.Report{}, "id = ?", first.ID).Error; err != nil {
		t.Fatal(err)
	}

	second := create("el segundo")
	if second.Seq == first.Seq {
		t.Fatalf("seq %d was handed out twice: both reports are called %s-%d, "+
			"so the folio no longer names one report",
			second.Seq, project.Slug, second.Seq)
	}
	if second.Seq != 2 {
		t.Errorf("expected the numbering to continue at 2, got %d", second.Seq)
	}
}

// Same hazard, the other way an id leaves the board: an archived report is
// hidden from the console but very much still there, and still named.
func TestAnArchivedReportKeepsItsNumber(t *testing.T) {
	db, cleanup := reportSeqDB(t)
	defer cleanup()
	repo := repository.NewReportRepository(db)

	project := &domain.ReportProject{OrgID: "org", Name: "acme", Slug: "acme", IngestKeyHash: []byte("h")}
	project.ID = "proj"
	if err := db.Create(project).Error; err != nil {
		t.Fatal(err)
	}

	first := &domain.Report{ProjectID: "proj", Title: "uno", Status: domain.ReportPending}
	if err := repo.CreateWithSeq(first); err != nil {
		t.Fatal(err)
	}
	// Reach past the model: whatever hides a row later, the number must hold.
	if err := db.Exec("UPDATE items SET status = 'closed' WHERE id = ?", first.ID).Error; err != nil {
		t.Fatal(err)
	}

	second := &domain.Report{ProjectID: "proj", Title: "dos", Status: domain.ReportPending}
	if err := repo.CreateWithSeq(second); err != nil {
		t.Fatal(err)
	}
	if second.Seq != 2 {
		t.Errorf("a closed report still owns its folio; expected 2, got %d", second.Seq)
	}
}

// And the scope is the project, not the table: two tenants both start at 1.
func TestNumberingIsPerProject(t *testing.T) {
	db, cleanup := reportSeqDB(t)
	defer cleanup()
	repo := repository.NewReportRepository(db)

	for _, slug := range []string{"uno", "dos"} {
		p := &domain.ReportProject{OrgID: "org", Name: slug, Slug: slug, IngestKeyHash: []byte("h-" + slug)}
		p.ID = slug
		if err := db.Create(p).Error; err != nil {
			t.Fatal(err)
		}
		rep := &domain.Report{ProjectID: slug, Title: "primero de " + slug, Status: domain.ReportPending}
		if err := repo.CreateWithSeq(rep); err != nil {
			t.Fatal(err)
		}
		if rep.Seq != 1 {
			t.Errorf("%s: each project numbers from 1, got %d", slug, rep.Seq)
		}
	}
}

func reportSeqDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_report_seq"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.ReportProject{}, &domain.Report{}); err != nil {
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
