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

// A space's channel: the rules that decide whether it is safe to have one.

// The invariant the whole design rests on, checked against the schema rather
// than against behaviour.
//
// Everywhere else in this codebase "who may read this" is a field, and a field
// can be defaulted wrong — one was, this week, and publishing a team note to a
// client took a constructor plus a source-scanning test to prevent. Here the
// answer is structural: a table that cannot express "public" cannot be made to
// leak by getting a flag wrong.
func TestAChannelCannotExpressBeingPublic(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()

	var cols []string
	if err := db.Raw(`SELECT column_name FROM information_schema.columns
		WHERE table_name = 'chat_messages'`).Scan(&cols).Error; err != nil {
		t.Fatal(err)
	}
	for _, c := range cols {
		if c == "visibility" || c == "project_id" {
			t.Errorf("chat_messages has a %q column. Chat is internal by construction: "+
				"the moment this is a field, it is a field somebody can default wrong", c)
		}
	}
}

func TestOnlyTheAuthorRewritesTheirOwnWords(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)

	m, err := svc.Post("space-1", "org-1", "u-ana", "lo mío")
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.Edit(m.ID, "u-bea", false, "lo cambio yo"); err != ErrNotTheAuthor {
		t.Errorf("editing someone else's words is not a permission an org role grants, got %v", err)
	}
	if err := svc.Withdraw(m.ID, "u-bea", false); err != ErrNotTheAuthor {
		t.Errorf("nor is withdrawing them, got %v", err)
	}
	// The author can, and so can a superadmin — the one exception, as elsewhere.
	if err := svc.Edit(m.ID, "u-ana", false, "corregido"); err != nil {
		t.Errorf("the author must be able to fix a typo: %v", err)
	}
	if err := svc.Withdraw(m.ID, "u-bea", true); err != nil {
		t.Errorf("a superadmin is the exception: %v", err)
	}
}

// Withdrawing hides; it does not destroy — and, crucially, the read has to agree.
//
// This one is a mirror of a bug that shipped: a message stayed on screen after
// being deleted because the query named its table as a string and quietly opted
// out of the soft-delete scope. Deleting looked broken, and trying again said
// "not found" about something plainly visible.
func TestAWithdrawnMessageLeavesTheChannelButNotTheRecord(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	keep, err := svc.Post("space-1", "org-1", "u-ana", "esto se queda")
	if err != nil {
		t.Fatal(err)
	}
	gone, err := svc.Post("space-1", "org-1", "u-ana", "esto se retira")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Withdraw(gone.ID, "u-ana", false); err != nil {
		t.Fatal(err)
	}

	msgs, err := repo.List("space-1", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].ID != keep.ID {
		t.Fatalf("the withdrawn line must be gone from the channel, got %d messages", len(msgs))
	}
	var still int64
	db.Unscoped().Model(&domain.ChatMessage{}).
		Where("id = ? AND deleted_at IS NOT NULL", gone.ID).Count(&still)
	if still != 1 {
		t.Error("and still on record: what somebody wrote is not ours to destroy")
	}
}

// Being told you have an unread message you just wrote is the same failure as
// being notified about your own comment — which this codebase spent an evening
// removing the day before this was written.
func TestYourOwnMessagesAreNeverUnread(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	if _, err := svc.Post("space-1", "org-1", "u-ana", "yo escribí esto"); err != nil {
		t.Fatal(err)
	}
	mine, err := repo.UnreadBySpace("u-ana", []string{"org-1"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 0 {
		t.Errorf("your own message must not come back as unread: %+v", mine)
	}

	// A colleague's does.
	theirs, err := repo.UnreadBySpace("u-bea", []string{"org-1"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(theirs) != 1 || theirs[0].Count != 1 {
		t.Fatalf("somebody else's message is unread until read: %+v", theirs)
	}

	// And reading clears it.
	if err := svc.MarkRead("space-1", "u-bea"); err != nil {
		t.Fatal(err)
	}
	after, _ := repo.UnreadBySpace("u-bea", []string{"org-1"}, false)
	if len(after) != 0 {
		t.Errorf("reading the channel clears its badge: %+v", after)
	}
}

// A channel belongs to one organization, and the badge query is a place where
// forgetting that would show one client's activity to another.
func TestUnreadNeverCrossesOrganizations(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	if _, err := svc.Post("space-otra", "org-otra", "u-ajeno", "de otra org"); err != nil {
		t.Fatal(err)
	}
	out, err := repo.UnreadBySpace("u-ana", []string{"org-1"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Errorf("a channel of an organization you don't belong to must not raise a badge: %+v", out)
	}
}

// A channel reads from the bottom: the first page is the tail, and it arrives
// in the order it will be rendered.
func TestTheChannelReadsFromTheBottom(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	for _, body := range []string{"uno", "dos", "tres"} {
		if _, err := svc.Post("space-1", "org-1", "u-ana", body); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond) // distinct timestamps
	}

	last2, err := repo.List("space-1", time.Time{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(last2) != 2 || last2[0].Body != "dos" || last2[1].Body != "tres" {
		t.Fatalf("a limit takes the newest, returned oldest-first: %+v", bodies(last2))
	}

	// Scrolling up asks for what came before the oldest one on screen.
	older, err := repo.List("space-1", last2[0].CreatedAt, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(older) != 1 || older[0].Body != "uno" {
		t.Fatalf("paging back should return only what precedes: %+v", bodies(older))
	}
}

func bodies(ms []domain.ChatMessageResponse) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Body
	}
	return out
}

func chatDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_chat"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.ChatMessage{},
		&domain.ChatRead{}, &domain.ChatAttachment{}); err != nil {
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

// Naming somebody who isn't there.
//
// The ids ride inside the message body, which is text the author typed — so a
// caller can name any uuid at all, including a person at another client. If
// those were taken at face value, a mention would be a way to ping strangers
// about work they have nothing to do with, from a channel they cannot even
// read.
func TestOnlyPeopleOfThisOrganizationCanBeMentioned(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.OrgMembership{}); err != nil {
		t.Fatal(err)
	}

	const mate = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8"
	const stranger = "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809"
	for _, m := range []domain.OrgMembership{
		{OrgID: "org-1", UserID: mate, Role: "member"},
		{OrgID: "org-otra", UserID: stranger, Role: "member"},
	} {
		if err := db.Create(&m).Error; err != nil {
			t.Fatal(err)
		}
	}

	repo := repository.NewChatRepository(db)
	got, err := repo.MembersOf("org-1", []string{mate, stranger})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != mate {
		t.Errorf("only the colleague may be named, got %v", got)
	}
}
