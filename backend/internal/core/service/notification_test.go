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

// The inbox: what survives closing the app.

// Marking read is scoped to the person doing it.
//
// The ids come from the client, so without the scope anybody holding a token
// could hand over somebody else's ids and quietly clear their inbox. Not
// destructive, but it is reaching into another person's account, and there is
// no reason to allow it.
func TestYouCanOnlyMarkYourOwnNotificationsRead(t *testing.T) {
	db, cleanup := inboxDB(t)
	defer cleanup()
	svc := NewNotificationService(repository.NewNotificationRepository(db))

	svc.Notify("u-ana", "org-1", "chat:mention", "Te nombraron", "", "/chat", domain.ViaApp)
	svc.Notify("u-bea", "org-1", "chat:mention", "Te nombraron", "", "/chat", domain.ViaApp)

	var deBea domain.Notification
	db.Where("user_id = ?", "u-bea").First(&deBea)

	// Ana tries to mark Bea's.
	if err := svc.MarkRead("u-ana", []string{deBea.ID}); err != nil {
		t.Fatal(err)
	}
	feedBea, _ := svc.Feed("u-bea", "org-1", 0)
	if feedBea.Unread != 1 {
		t.Errorf("Bea's notification should still be unread, unread=%d", feedBea.Unread)
	}
}

// An inbox is one organization's at a time: switching should not show another
// client's traffic.
func TestTheInboxIsScopedToTheOrganization(t *testing.T) {
	db, cleanup := inboxDB(t)
	defer cleanup()
	svc := NewNotificationService(repository.NewNotificationRepository(db))

	svc.Notify("u-ana", "org-1", "chat:mention", "Aquí", "", "/chat", domain.ViaApp)
	svc.Notify("u-ana", "org-2", "chat:mention", "Allá", "", "/chat", domain.ViaApp)

	uno, _ := svc.Feed("u-ana", "org-1", 0)
	if len(uno.Items) != 1 || uno.Items[0].Title != "Aquí" {
		t.Errorf("one organization's inbox should hold one thing: %+v", uno.Items)
	}
	if uno.Unread != 1 {
		t.Errorf("and count only its own, got %d", uno.Unread)
	}
}

// The badge counts everything unread, not just what fits on a page.
//
// Derived from the page it would freeze at the page size, and an inbox that
// says "50" forever is one nobody believes.
func TestTheUnreadCountIsNotLimitedByThePage(t *testing.T) {
	db, cleanup := inboxDB(t)
	defer cleanup()
	svc := NewNotificationService(repository.NewNotificationRepository(db))

	for i := 0; i < 12; i++ {
		svc.Notify("u-ana", "org-1", "chat:mention", fmt.Sprintf("n%d", i), "", "/chat", domain.ViaApp)
	}
	feed, _ := svc.Feed("u-ana", "org-1", 5)
	if len(feed.Items) != 5 {
		t.Errorf("asked for five, got %d", len(feed.Items))
	}
	if feed.Unread != 12 {
		t.Errorf("but the badge counts all twelve, got %d", feed.Unread)
	}
}

// Marking everything read is also one person, one organization.
func TestMarkAllReadLeavesOtherOrganizationsAlone(t *testing.T) {
	db, cleanup := inboxDB(t)
	defer cleanup()
	svc := NewNotificationService(repository.NewNotificationRepository(db))

	svc.Notify("u-ana", "org-1", "chat:mention", "Aquí", "", "/chat", domain.ViaApp)
	svc.Notify("u-ana", "org-2", "chat:mention", "Allá", "", "/chat", domain.ViaApp)

	if err := svc.MarkAllRead("u-ana", "org-1"); err != nil {
		t.Fatal(err)
	}
	otra, _ := svc.Feed("u-ana", "org-2", 0)
	if otra.Unread != 1 {
		t.Errorf("the other organization's inbox should be untouched, unread=%d", otra.Unread)
	}
}

// Preferences silence what somebody asked to be silent about — except being
// named, which is never negotiable.
func TestPreferencesSilenceAKindButNeverAMention(t *testing.T) {
	db, cleanup := inboxDB(t)
	defer cleanup()
	svc := NewNotificationService(repository.NewNotificationRepository(db))

	prefs := domain.DefaultPrefs("u-ana")
	prefs.DMs = false
	// Turned off too, and it must make no difference. Leaving it on would let
	// this test pass whether or not mentions are actually unsilenceable.
	prefs.Mentions = false
	if err := svc.SavePrefs(prefs); err != nil {
		t.Fatal(err)
	}

	svc.Notify("u-ana", "org-1", "dm:message", "Alguien te escribió", "", "/dm", domain.ViaApp)
	svc.Notify("u-ana", "org-1", "chat:mention", "Te nombraron", "", "/chat", domain.ViaApp)

	feed, _ := svc.Feed("u-ana", "org-1", 0)
	if len(feed.Items) != 1 {
		t.Fatalf("the silenced kind should not be recorded: %+v", feed.Items)
	}
	if feed.Items[0].Kind != "chat:mention" {
		t.Errorf("being named must survive any preference, got %q", feed.Items[0].Kind)
	}
}

// Somebody who never touched this gets everything, not nothing.
func TestWithoutPreferencesEverythingArrives(t *testing.T) {
	db, cleanup := inboxDB(t)
	defer cleanup()
	svc := NewNotificationService(repository.NewNotificationRepository(db))

	p, err := svc.Prefs("u-nueva")
	if err != nil {
		t.Fatal(err)
	}
	if !p.DMs || !p.Comments || !p.Reports || !p.Mentions {
		t.Errorf("the default is everything on, got %+v", p)
	}
}

func inboxDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_inbox"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Notification{}, &domain.NotificationPrefs{}); err != nil {
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
