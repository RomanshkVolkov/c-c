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

// How many people are in an organization, answered where it is asked.
//
// The sidebar names the organization you are working in and says how big it is,
// and the only way to get that number before was to pull the whole member list
// of every organization on screen. Counted in the same query that lists them.

func TestListingOrganizationsSaysHowManyPeopleAreInEach(t *testing.T) {
	db, cleanup := orgCountDB(t)
	defer cleanup()
	svc := NewOrganizationService(repository.NewOrganizationRepository(db))

	orgs, err := svc.List("u-ana", false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, o := range orgs {
		got[o.ID] = o.MemberCount
	}
	if got["org-1"] != 3 {
		t.Errorf("org-1 has three members, got %d", got["org-1"])
	}
	// The one Ana isn't in must not appear at all — the count is not a way to
	// learn about organizations you're outside of.
	if _, visible := got["org-otra"]; visible {
		t.Error("an organization you don't belong to should not be listed")
	}
}

// A superadmin sees every organization, and the count still has to be that
// organization's own rather than the one it was joined against.
func TestASuperadminSeesEveryOrganizationWithItsOwnCount(t *testing.T) {
	db, cleanup := orgCountDB(t)
	defer cleanup()
	svc := NewOrganizationService(repository.NewOrganizationRepository(db))

	orgs, err := svc.List("u-root", true)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, o := range orgs {
		got[o.ID] = o.MemberCount
	}
	if got["org-1"] != 3 || got["org-otra"] != 1 {
		t.Errorf("counts should be per organization, got %+v", got)
	}
}

func orgCountDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_org_count"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.User{}, &domain.OrgMembership{}); err != nil {
		t.Fatal(err)
	}
	uno := &domain.Organization{Name: "Uno", Slug: "uno"}
	uno.ID = "org-1"
	otra := &domain.Organization{Name: "Otra", Slug: "otra"}
	otra.ID = "org-otra"
	if err := db.Create([]any{uno, otra}[0]).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(otra).Error; err != nil {
		t.Fatal(err)
	}
	for _, m := range []domain.OrgMembership{
		{OrgID: "org-1", UserID: "u-ana", Role: "admin"},
		{OrgID: "org-1", UserID: "u-bea", Role: "member"},
		{OrgID: "org-1", UserID: "u-carla", Role: "viewer"},
		{OrgID: "org-otra", UserID: "u-ajeno", Role: "admin"},
	} {
		if err := db.Create(&m).Error; err != nil {
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
