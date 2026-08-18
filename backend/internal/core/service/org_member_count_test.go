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

// The members table shows who they are and when they were last around.
//
// Last seen is written at most once every few minutes, in the database and not
// in Go: two requests arriving together would otherwise both read a stale
// timestamp and both decide to write, which defeats the point of throttling it.
func TestTheMembersListCarriesEmailAndLastSeen(t *testing.T) {
	db, cleanup := orgCountDB(t)
	defer cleanup()
	repo := repository.NewOrganizationRepository(db)
	auth := repository.NewAuthRepository(db)

	auth.TouchLastSeen("u-ana")

	miembros, err := repo.ListMembers("org-1")
	if err != nil {
		t.Fatal(err)
	}
	var ana, bea *domain.MemberResponse
	for i := range miembros {
		switch miembros[i].UserID {
		case "u-ana":
			ana = &miembros[i]
		case "u-bea":
			bea = &miembros[i]
		}
	}
	if ana == nil || bea == nil {
		t.Fatalf("expected both members, got %+v", miembros)
	}
	if ana.Email != "ana@example.com" {
		t.Errorf("the table shows the email, got %q", ana.Email)
	}
	if ana.LastSeenAt == nil {
		t.Error("Ana was just seen")
	}
	// Y quien no ha hecho nada no se inventa una fecha.
	if bea.LastSeenAt != nil {
		t.Errorf("Bea has done nothing, got %v", bea.LastSeenAt)
	}

	// Un segundo toque inmediato no vuelve a escribir.
	primera := *ana.LastSeenAt
	auth.TouchLastSeen("u-ana")
	otra, _ := repo.ListMembers("org-1")
	for _, m := range otra {
		if m.UserID == "u-ana" && !m.LastSeenAt.Equal(primera) {
			t.Error("touching again within the window should not write")
		}
	}
}

// Ending an organization is not an admin's decision.
//
// Deleting it takes its spaces, its tasks and its channels, and stops every
// integration pointing at it. An org admin runs the place; ending it is a
// different kind of act, and one nobody should be able to do to a client on
// their own. The typed confirmation the app asks for is a second lock, not
// this one.
func TestOnlyASuperadminCanDeleteAnOrganization(t *testing.T) {
	db, cleanup := orgCountDB(t)
	defer cleanup()
	svc := NewOrganizationService(repository.NewOrganizationRepository(db))

	// Ana is an admin of org-1 and it makes no difference.
	if err := svc.Delete("u-ana", "org-1", false); err != ErrOnlySuperadminDeletes {
		t.Errorf("an org admin deleting → %v, want a refusal", err)
	}
	var quedan int64
	db.Model(&domain.Organization{}).Where("id = ?", "org-1").Count(&quedan)
	if quedan != 1 {
		t.Error("and the organization is still there")
	}

	// The other half — that a superadmin *can* — is not asserted here on
	// purpose: deleting cascades through most of the schema, and a fixture that
	// mirrored all of it would be testing AutoMigrate rather than this rule.
	// What is new is the refusal, and that is what this pins down.
}

// A new organization starts with its rules written, not left to the schema.
func TestANewOrganizationStartsWithItsRulesOn(t *testing.T) {
	db, cleanup := orgCountDB(t)
	defer cleanup()
	svc := NewOrganizationService(repository.NewOrganizationRepository(db))

	creada, err := svc.Create("u-ana", domain.CreateOrganizationRequest{Name: "Nueva"})
	if err != nil {
		t.Fatal(err)
	}
	var org domain.Organization
	db.First(&org, "id = ?", creada.ID)
	// Written explicitly at creation: a `default:true` column would make these
	// impossible to turn off, because GORM omits Go zero values on insert.
	if !org.ClientsSeeOnlyTheirSpace || !org.GuestsCanUseDevTools {
		t.Errorf("the rules should start on, got %+v", org)
	}
	if org.DefaultInviteRole != domain.OrgRoleMember {
		t.Errorf("default invite role = %q, want member", org.DefaultInviteRole)
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
	if err := db.AutoMigrate(
		&domain.Organization{}, &domain.User{}, &domain.OrgMembership{},
		&domain.ReportProject{}, &domain.Server{},
	); err != nil {
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
	for _, u := range []struct{ id, name, mail string }{
		{"u-ana", "ana", "ana@example.com"},
		{"u-bea", "bea", "bea@example.com"},
		{"u-carla", "carla", "carla@example.com"},
	} {
		user := &domain.User{Username: u.name, Email: u.mail}
		user.ID = u.id
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
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
