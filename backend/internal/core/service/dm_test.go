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

// A private conversation between two people.

// The one that decides whether any of this works.
//
// Ana opening a thread with Bea and Bea opening one with Ana must land on the
// same row. Without the canonical ordering they get one each, and then both
// write happily into a thread the other never reads — no error, no empty
// screen, nothing that looks wrong from either side. That failure is silent by
// construction, which is why it is the first test here.
func TestOpeningFromEitherSideIsTheSameConversation(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)

	fromAna, err := repo.OpenWith("org-1", "u-ana", "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	fromBea, err := repo.OpenWith("org-1", "u-bea", "u-ana")
	if err != nil {
		t.Fatal(err)
	}
	if fromAna.ID != fromBea.ID {
		t.Fatalf("two conversations for one pair: %s vs %s", fromAna.ID, fromBea.ID)
	}

	var n int64
	db.Model(&domain.DMConversation{}).Count(&n)
	if n != 1 {
		t.Errorf("expected exactly one row, got %d", n)
	}
}

// The same two people in two organizations get two threads. The organization is
// part of what is being said, and merging them would carry one client's work
// into another's.
func TestTheSamePairInTwoOrganizationsHasTwoConversations(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)

	a, err := repo.OpenWith("org-1", "u-ana", "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	b, err := repo.OpenWith("org-2", "u-ana", "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID {
		t.Error("one thread spanning two organizations mixes a client's work with another's")
	}
}

// You can only write to somebody you actually work with.
func TestYouCannotOpenAConversationWithSomebodyFromAnotherOrganization(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()

	_, err := repository.NewDMRepository(db).OpenWith("org-1", "u-ana", "u-ajeno")
	if err != repository.ErrNotColleagues {
		t.Errorf("expected a refusal, got %v", err)
	}
}

// A conversation you are not part of does not exist as far as you're concerned.
//
// Not-found rather than forbidden: "that thread exists but isn't yours" is
// itself a fact about who talks to whom.
func TestAConversationYouAreNotInIsNotFound(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	svc := NewDMService(repo, nil)

	c, err := repo.OpenWith("org-1", "u-ana", "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.List(c.ID, "u-carla", time.Time{}, 50); err != repository.ErrConversationNotFound {
		t.Errorf("reading somebody else's conversation → %v, want not-found", err)
	}
	if _, err := svc.Post(c.ID, "u-carla", "hola"); err != repository.ErrConversationNotFound {
		t.Errorf("writing into it → %v, want not-found", err)
	}
}

// Being in the conversation is not permission to rewrite what the other person
// said.
func TestOnlyTheAuthorRewritesTheirOwnLine(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	svc := NewDMService(repo, nil)

	c, _ := repo.OpenWith("org-1", "u-ana", "u-bea")
	m, err := svc.Post(c.ID, "u-ana", "lo mío")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Edit(c.ID, m.ID, "u-bea", false, "lo cambio yo"); err != ErrNotTheAuthor {
		t.Errorf("the other person must not rewrite it, got %v", err)
	}
	if err := svc.Edit(c.ID, m.ID, "u-ana", false, "corregido"); err != nil {
		t.Errorf("the author must be able to fix a typo: %v", err)
	}
}

// Unread counts the other person's messages, never your own, and reading clears
// them.
func TestUnreadInAConversation(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	svc := NewDMService(repo, nil)

	c, _ := repo.OpenWith("org-1", "u-ana", "u-bea")
	if _, err := svc.Post(c.ID, "u-ana", "¿lo viste?"); err != nil {
		t.Fatal(err)
	}

	mine, err := repo.Conversations("u-ana", []string{"org-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 1 || mine[0].Unread != 0 {
		t.Errorf("your own message is not unread to you: %+v", mine)
	}

	theirs, _ := repo.Conversations("u-bea", []string{"org-1"})
	if len(theirs) != 1 || theirs[0].Unread != 1 {
		t.Fatalf("the other person has one to read: %+v", theirs)
	}
	if theirs[0].UserID != "u-ana" {
		t.Errorf("the row should name who it's with, got %q", theirs[0].UserID)
	}

	if err := svc.MarkRead(c.ID, "u-bea"); err != nil {
		t.Fatal(err)
	}
	after, _ := repo.Conversations("u-bea", []string{"org-1"})
	if after[0].Unread != 0 {
		t.Errorf("reading clears it: %+v", after)
	}
}

// A withdrawn line leaves the thread but not the record.
func TestAWithdrawnLineLeavesTheThread(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	svc := NewDMService(repo, nil)

	c, _ := repo.OpenWith("org-1", "u-ana", "u-bea")
	keep, _ := svc.Post(c.ID, "u-ana", "esto se queda")
	gone, _ := svc.Post(c.ID, "u-ana", "esto se retira")
	if err := svc.Withdraw(c.ID, gone.ID, "u-ana", false); err != nil {
		t.Fatal(err)
	}

	msgs, err := repo.List(c.ID, time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].ID != keep.ID {
		t.Fatalf("the withdrawn line must be gone, got %d", len(msgs))
	}
	var still int64
	db.Unscoped().Model(&domain.DMMessage{}).
		Where("id = ? AND deleted_at IS NOT NULL", gone.ID).Count(&still)
	if still != 1 {
		t.Error("and still on record")
	}
}

// Somebody else's conversation never appears in your list, whatever org you are
// in. This is the read that would leak a whole thread rather than one message.
func TestYourListOnlyHasYourConversations(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)

	if _, err := repo.OpenWith("org-1", "u-bea", "u-carla"); err != nil {
		t.Fatal(err)
	}
	mine, err := repo.Conversations("u-ana", []string{"org-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 0 {
		t.Errorf("a conversation between two colleagues is not yours to see: %+v", mine)
	}
}

func dmDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_dm"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.OrgMembership{},
		&domain.DMConversation{}, &domain.DMMessage{}, &domain.DMRead{}); err != nil {
		t.Fatal(err)
	}
	// Ana, Bea and Carla work together; the stranger is somewhere else.
	for _, u := range []struct{ id, name, org string }{
		{"u-ana", "ana", "org-1"}, {"u-bea", "bea", "org-1"}, {"u-carla", "carla", "org-1"},
		{"u-ajeno", "ajeno", "org-otra"},
	} {
		user := &domain.User{Username: u.name}
		user.ID = u.id
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&domain.OrgMembership{OrgID: u.org, UserID: u.id, Role: "member"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Ana and Bea also share a second organization.
	for _, id := range []string{"u-ana", "u-bea"} {
		if err := db.Create(&domain.OrgMembership{OrgID: "org-2", UserID: id, Role: "member"}).Error; err != nil {
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

// A superadmin joins the organizations that get created, as an ordinary admin.
//
// Not for reach — they can already see every organization — but so the rest of
// the platform can reach *them*. Membership is what the people picker lists and
// what a mention is checked against, so a superadmin outside every organization
// is somebody nobody can name or write to, while their own picker offers
// colleagues the server then refuses. That gap is what "not-colleagues" was.
func TestCreatingAnOrganizationBringsTheSuperadminsIn(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.Organization{}); err != nil {
		t.Fatal(err)
	}
	root := &domain.User{Username: "root", IsSuperadmin: true}
	root.ID = "u-root"
	if err := db.Create(root).Error; err != nil {
		t.Fatal(err)
	}

	org := &domain.Organization{Name: "Nueva", Slug: "nueva"}
	org.ID = "org-nueva"
	if err := repository.NewOrganizationRepository(db).CreateWithOwner(org, "u-ana"); err != nil {
		t.Fatal(err)
	}

	var roles []string
	db.Model(&domain.OrgMembership{}).Where("org_id = ? AND user_id = ?", org.ID, "u-root").
		Pluck("role", &roles)
	if len(roles) != 1 {
		t.Fatal("the superadmin was left outside the organization that was just created")
	}

	// And the owner is still the owner.
	var ownerRoles []string
	db.Model(&domain.OrgMembership{}).Where("org_id = ? AND user_id = ?", org.ID, "u-ana").
		Pluck("role", &ownerRoles)
	if len(ownerRoles) != 1 {
		t.Error("the person who created it must be a member too")
	}
}
