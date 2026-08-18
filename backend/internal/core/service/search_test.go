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

// The palette, and the four different fences it has to respect at once.

// The one that matters most: a search must never surface somebody else's
// direct messages.
//
// The DM tables were built with no visibility column on purpose — a table that
// cannot express "public" cannot leak by getting a flag wrong. A search is the
// first read path that crosses every source at once, and it is exactly where
// that guarantee would be given away. The query starts from the conversations
// the caller is in, so it cannot express another person's mail.
func TestSearchNeverReturnsSomebodyElsesDirectMessages(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	svc := NewSearchService(repository.NewSearchRepository(db))

	// Bea and Carla say the word; Ana is in neither conversation.
	res, err := svc.Search("secreto", "org-1", "u-ana", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.DMs) != 0 {
		t.Fatalf("Ana must not see a conversation she is not in: %+v", res.DMs)
	}

	// Bea is, and finds her own.
	suyo, _ := svc.Search("secreto", "org-1", "u-bea", 0)
	if len(suyo.DMs) != 1 {
		t.Errorf("Bea should find her own message, got %+v", suyo.DMs)
	}
}

// Notes are personal, so the fence is the owner and not the organization.
func TestSearchOnlyReturnsYourOwnNotes(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	svc := NewSearchService(repository.NewSearchRepository(db))

	mias, _ := svc.Search("apunte", "org-1", "u-ana", 0)
	if len(mias.Notes) != 1 {
		t.Fatalf("Ana should find her own note, got %+v", mias.Notes)
	}
	ajenas, _ := svc.Search("apunte", "org-1", "u-bea", 0)
	if len(ajenas.Notes) != 0 {
		t.Errorf("Bea must not find Ana's note: %+v", ajenas.Notes)
	}
}

// Naming an organization you are not in must not widen anything.
//
// The handler blanks the org for a non-member, and every source that takes one
// treats empty as "nothing" rather than "all of them" — which is the failure
// this asserts against.
func TestWithoutAnOrganizationNothingOrganizationalComesBack(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	svc := NewSearchService(repository.NewSearchRepository(db))

	res, err := svc.Search("tarea", "", "u-ana", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tasks) != 0 || len(res.People) != 0 || len(res.Messages) != 0 {
		t.Errorf("no organization should mean nothing organizational: %+v", res)
	}
}

// A one-letter query matches most of a database, which is a slow way to be
// useless.
func TestATooShortQueryAsksTheDatabaseNothing(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	svc := NewSearchService(repository.NewSearchRepository(db))

	res, _ := svc.Search("a", "org-1", "u-ana", 0)
	if len(res.Tasks)+len(res.Notes)+len(res.People)+len(res.Messages)+len(res.DMs) != 0 {
		t.Errorf("a one-letter query should return nothing, got %+v", res)
	}
}

// And the ordinary case still works.
func TestSearchFindsTasksAndChannelMessagesOfYourOrganization(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	svc := NewSearchService(repository.NewSearchRepository(db))

	res, _ := svc.Search("tarea", "org-1", "u-ana", 0)
	if len(res.Tasks) != 1 {
		t.Errorf("should find the task, got %+v", res.Tasks)
	}
	msg, _ := svc.Search("canal", "org-1", "u-ana", 0)
	if len(msg.Messages) != 1 {
		t.Errorf("should find the channel message, got %+v", msg.Messages)
	}
}

func searchDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_search"
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
		&domain.TaskSpace{}, &domain.TaskList{}, &domain.Item{},
		&domain.Note{}, &domain.ChatMessage{},
		&domain.DMConversation{}, &domain.DMMessage{},
	); err != nil {
		t.Fatal(err)
	}

	org := &domain.Organization{Name: "Uno", Slug: "uno"}
	org.ID = "org-1"
	sp := &domain.TaskSpace{OrgID: "org-1", Name: "Espacio", Rank: "U"}
	sp.ID = "space-1"
	li := &domain.TaskList{SpaceID: "space-1", Name: "Lista", Rank: "U"}
	li.ID = "list-1"
	it := &domain.Item{OrgID: "org-1", ListID: "list-1", Title: "Una tarea cualquiera", Status: domain.ReportPending}
	it.ID = "it-1"
	nota := &domain.Note{OwnerID: "u-ana", Title: "Mi apunte"}
	nota.ID = "note-1"
	msg := &domain.ChatMessage{SpaceID: "space-1", AuthorUserID: "u-bea", Body: "algo del canal"}
	msg.ID = "msg-1"
	conv := &domain.DMConversation{OrgID: "org-1", UserLoID: "u-bea", UserHiID: "u-carla"}
	conv.ID = "conv-1"
	dm := &domain.DMMessage{ConversationID: "conv-1", OrgID: "org-1", AuthorUserID: "u-bea", Body: "esto es secreto"}
	dm.ID = "dm-1"
	for _, m := range []any{org, sp, li, it, nota, msg, conv, dm} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, u := range []struct{ id, name string }{{"u-ana", "ana"}, {"u-bea", "bea"}, {"u-carla", "carla"}} {
		user := &domain.User{Username: u.name}
		user.ID = u.id
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&domain.OrgMembership{OrgID: "org-1", UserID: u.id, Role: "member"}).Error; err != nil {
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
