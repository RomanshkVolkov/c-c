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

// Who you are allowed to name.
//
// The search this replaces (SearchByUsername) looks across the whole platform,
// which is right for the screens it was written for — a superadmin adding
// someone to an org has to be able to find people who aren't in one yet.
//
// It is wrong for the two things being built on top of it. Mentioning somebody
// pings them about work they may have nothing to do with, and a direct message
// opens a conversation; offering names from another client's organization in
// either picker is offering to do something nobody should be able to do.
func TestSearchingPeopleStaysInsideTheOrganization(t *testing.T) {
	db, cleanup := orgSearchDB(t)
	defer cleanup()

	seedMember(t, db, "u-ana", "ana", "org-1")
	seedMember(t, db, "u-ale", "alejandro", "org-1")
	// Same name shape, different organization: the case that decides whether
	// the filter is real.
	seedMember(t, db, "u-otra", "ana-de-otro-cliente", "org-2")

	repo := repository.NewAuthRepository(db)
	got, err := repo.SearchUsersInOrg("a", "org-1", "", 10)
	if err != nil {
		t.Fatal(err)
	}

	names := map[string]bool{}
	for _, u := range got {
		names[u.Username] = true
	}
	if !names["ana"] || !names["alejandro"] {
		t.Errorf("should find the people of this organization, got %v", names)
	}
	if names["ana-de-otro-cliente"] {
		t.Error("somebody from another organization must never be offered — mentioning or messaging them is not a thing anyone here may do")
	}
}

// You are not a person you need to be offered: mentioning yourself notifies
// nobody, and there is no conversation to open with yourself.
func TestTheSearchLeavesYouOut(t *testing.T) {
	db, cleanup := orgSearchDB(t)
	defer cleanup()
	seedMember(t, db, "u-ana", "ana", "org-1")
	seedMember(t, db, "u-ale", "alejandro", "org-1")

	got, err := repository.NewAuthRepository(db).SearchUsersInOrg("a", "org-1", "u-ana", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range got {
		if u.ID == "u-ana" {
			t.Error("the caller should not be in their own picker")
		}
	}
	if len(got) != 1 {
		t.Errorf("expected just the colleague, got %d", len(got))
	}
}

// A user row with no membership is nobody's colleague. This is the shape a
// platform admin has before being added anywhere.
func TestSomebodyInNoOrganizationIsNeverOffered(t *testing.T) {
	db, cleanup := orgSearchDB(t)
	defer cleanup()
	seedMember(t, db, "u-ana", "ana", "org-1")
	loose := &domain.User{Username: "andres-sin-org"}
	loose.ID = "u-suelto"
	if err := db.Create(loose).Error; err != nil {
		t.Fatal(err)
	}

	got, err := repository.NewAuthRepository(db).SearchUsersInOrg("an", "org-1", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range got {
		if u.ID == "u-suelto" {
			t.Error("a user who belongs to no organization is not a colleague of anyone")
		}
	}
}

func seedMember(t *testing.T, db *gorm.DB, id, username, orgID string) {
	t.Helper()
	u := &domain.User{Username: username}
	u.ID = id
	if err := db.Create(u).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.OrgMembership{OrgID: orgID, UserID: id, Role: "member"}).Error; err != nil {
		t.Fatal(err)
	}
}

func orgSearchDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_org_search"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.OrgMembership{}); err != nil {
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
