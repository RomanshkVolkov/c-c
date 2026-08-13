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

// A superadmin belongs to no organization and therefore sees every one, which
// is right for the reports board and wrong for anything that claims to be
// showing *this* tenant — the dashboard summary showed one client's reports
// while another client was selected.
//
// ?orgId has to narrow, and only narrow: layered on top of membership, never
// in place of it, so it can't become a way to reach a tenant you can't see.
func TestListNarrowsToOneOrgWithoutWideningAccess(t *testing.T) {
	db, cleanup := reportScopeDB(t)
	defer cleanup()

	mk := func(orgID, projectID, title string) {
		p := &domain.ReportProject{OrgID: orgID, Name: projectID, Slug: projectID, IngestKeyHash: []byte("hash-" + projectID)}
		p.ID = projectID
		if err := db.Create(p).Error; err != nil {
			t.Fatal(err)
		}
		rep := &domain.Report{ProjectID: projectID, Title: title, Status: domain.ReportPending}
		rep.ID = "rep-" + projectID
		if err := db.Create(rep).Error; err != nil {
			t.Fatal(err)
		}
	}
	mk("org-dwit", "proj-dwit", "de dwit")
	mk("org-nuke", "proj-nuke", "de nuke")

	repo := repository.NewReportRepository(db)
	q := func(orgID string, orgIDs []string, superadmin bool) []string {
		res, err := repo.List(orgIDs, domain.ReportListQuery{OrgID: orgID, Limit: 50}, superadmin)
		if err != nil {
			t.Fatal(err)
		}
		out := make([]string, len(res.Items))
		for i, item := range res.Items {
			out[i] = item.Title
		}
		return out
	}

	// The bug: a superadmin asking for nothing in particular sees both. That's
	// intended for the reports board, and it's why the summary needs the filter.
	if got := q("", nil, true); len(got) != 2 {
		t.Fatalf("a superadmin should still see every org unfiltered, got %v", got)
	}
	// The fix.
	if got := q("org-dwit", nil, true); len(got) != 1 || got[0] != "de dwit" {
		t.Fatalf("?orgId must narrow a superadmin to one org, got %v", got)
	}
	// And it narrows only. A member of dwit asking for nuke's reports gets
	// nothing — not nuke's, and not their own silently substituted.
	if got := q("org-nuke", []string{"org-dwit"}, false); len(got) != 0 {
		t.Fatalf("?orgId must not widen access, got %v", got)
	}
	if got := q("", []string{"org-dwit"}, false); len(got) != 1 || got[0] != "de dwit" {
		t.Fatalf("membership alone should still scope, got %v", got)
	}
}

func reportScopeDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_report_scope"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.ReportProject{}, &domain.Report{}, &domain.User{}, &domain.ReportComment{}, &domain.ReportImage{}, &domain.ItemAssignee{}); err != nil {
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
