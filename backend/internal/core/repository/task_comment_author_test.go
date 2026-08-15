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

// Who said what, read through the *task* side of the board.
//
// The two facades read the same thread, and only one of them could name a
// person who has no cac account. The task reader resolved the author with a
// single `LEFT JOIN users`, so a reply from the client or from their app came
// back with an empty name — on screen, the client's half of the conversation
// was anonymous. The report reader has always got this right, via tagAuthor,
// whose own comment says a single place must decide this because every reader
// that worked it out for itself got it wrong at least once.
//
// This is that same mistake, in the reader nobody had checked.

func seedThread(t *testing.T, db *gorm.DB) string {
	t.Helper()
	project := &domain.ReportProject{
		Name: "Portento", Slug: "portento", OrgID: "org-1",
		IngestKeyHash: []byte("unused-here"), Platform: "app",
	}
	project.ID = "pr-1"
	if err := db.Create(project).Error; err != nil {
		t.Fatal(err)
	}
	author := &domain.User{Username: "RomanshkVolkov"}
	author.ID = "us-1"
	if err := db.Create(author).Error; err != nil {
		t.Fatal(err)
	}

	// The item carries the reporter's id in the tenant's own id space; that is
	// what makes a comment "the reporter's" rather than "the tenant app's".
	item := &domain.Item{
		OrgID: "org-1", ListID: "li-1", ProjectID: "pr-1", Seq: 89,
		Title: "Los reportes no migran", ReporterID: "3", ReporterName: "Sebastian Ramirez",
	}
	item.ID = "it-1"
	if err := db.Create(item).Error; err != nil {
		t.Fatal(err)
	}

	uid := "us-1"
	pid := "pr-1"
	comments := []*domain.ItemComment{
		{ItemID: "it-1", Kind: "user", Body: "reviso", AuthorUserID: &uid, Visibility: "public"},
		// The reporter: the tenant asserts an external id that matches the
		// item's reporter.
		{ItemID: "it-1", Kind: "user", Body: "No entendí", AuthorProjectID: &pid,
			AuthorExternalID: "3", AuthorExternalName: "Sebastian Ramirez", Visibility: "public"},
		// The tenant's app speaking as somebody who is not the reporter.
		{ItemID: "it-1", Kind: "user", Body: "lo vemos", AuthorProjectID: &pid,
			AuthorExternalID: "9", AuthorExternalName: "Soporte", Visibility: "public"},
		{ItemID: "it-1", Kind: "system", Body: "status: pending → in_progress", Visibility: "public"},
	}
	for i, c := range comments {
		c.ID = fmt.Sprintf("co-%d", i)
		if err := db.Create(c).Error; err != nil {
			t.Fatal(err)
		}
	}
	return "it-1"
}

func TestTheTaskThreadNamesPeopleWithoutACacAccount(t *testing.T) {
	db, cleanup := commentDB(t)
	defer cleanup()
	id := seedThread(t, db)

	out, err := repository.NewTaskRepository(db).Comments(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 4 {
		t.Fatalf("expected the whole thread, got %d", len(out))
	}

	byBody := map[string]domain.TaskCommentResponse{}
	for _, c := range out {
		byBody[c.Body] = c
	}

	// The regression: this line is the client's, and it used to arrive nameless.
	reporter := byBody["No entendí"]
	if reporter.AuthorName != "Sebastian Ramirez" {
		t.Errorf("the reporter's reply came back as %q — on screen that is an anonymous message", reporter.AuthorName)
	}
	if reporter.Author == nil || reporter.Author.Kind != domain.AuthorKindReporter {
		t.Errorf("the reporter must be tagged as such, got %+v", reporter.Author)
	}

	// Somebody at the tenant who is not the reporter is still named, but as the
	// tenant — the external name is only *asserted* by them, so it must never
	// appear without saying who vouched for it.
	tenant := byBody["lo vemos"]
	if tenant.Author == nil || tenant.Author.Kind == domain.AuthorKindReporter {
		t.Errorf("a non-reporter at the tenant must not be tagged as the reporter: %+v", tenant.Author)
	}
	if tenant.Author != nil && tenant.Author.ProjectName == "" {
		t.Error("the asserted name must travel with the project that asserted it")
	}

	// And the cases that already worked keep working.
	if mine := byBody["reviso"]; mine.AuthorName != "RomanshkVolkov" ||
		mine.Author == nil || mine.Author.Kind != domain.AuthorKindUser {
		t.Errorf("a cac account should still resolve: %q %+v", mine.AuthorName, mine.Author)
	}
	if sys := byBody["status: pending → in_progress"]; sys.Author != nil {
		t.Errorf("a system line has no author to name: %+v", sys.Author)
	}
}

func commentDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_comment_author"
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
		&domain.User{}, &domain.ReportProject{}, &domain.Item{},
		&domain.ItemComment{}, &domain.ItemAttachment{},
	); err != nil {
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

// The folio as a reference you can paste.
//
// A folio is meant to be quoted — into a chat message, a ticket, an agent's
// prompt. Until now only the composing half existed: domain.Folio built the
// string and nothing could turn one back into a row, so a name that names
// something had to be searched for before it could be used.
func TestAFolioFindsTheThingItNames(t *testing.T) {
	db, cleanup := commentDB(t)
	defer cleanup()
	id := seedThread(t, db)
	repo := repository.NewTaskRepository(db)

	found, err := repo.FindTask("portento-89")
	if err != nil {
		t.Fatalf("the folio should find its item: %v", err)
	}
	if found.ID != id {
		t.Errorf("resolved to %q, want %q", found.ID, id)
	}

	// The id still works, and is still the fast path.
	if byID, err := repo.FindTask(id); err != nil || byID.ID != id {
		t.Errorf("the id must keep resolving: %v", err)
	}
}

// Slugs contain hyphens, so where you cut decides what you find.
func TestAFolioIsCutAtTheLastHyphen(t *testing.T) {
	db, cleanup := commentDB(t)
	defer cleanup()
	seedThread(t, db)

	// A second channel whose slug has hyphens of its own — the case that a
	// front-cutting parser gets wrong: it would look for a project called "tds"
	// and a sequence of "geolocation-4".
	project := &domain.ReportProject{
		Name: "TDS", Slug: "tds-geolocation", OrgID: "org-1",
		IngestKeyHash: []byte("h"), Platform: "app",
	}
	project.ID = "pr-2"
	if err := db.Create(project).Error; err != nil {
		t.Fatal(err)
	}
	item := &domain.Item{OrgID: "org-1", ListID: "li-2", ProjectID: "pr-2", Seq: 4, Title: "geo"}
	item.ID = "it-2"
	if err := db.Create(item).Error; err != nil {
		t.Fatal(err)
	}

	repo := repository.NewTaskRepository(db)
	found, err := repo.FindTask("tds-geolocation-4")
	if err != nil || found.ID != "it-2" {
		t.Errorf("a slug with hyphens must still resolve: %v %+v", err, found)
	}
}

// What must not resolve, because resolving it would hand back the wrong card.
func TestWhatIsNotAFolio(t *testing.T) {
	db, cleanup := commentDB(t)
	defer cleanup()
	seedThread(t, db)
	repo := repository.NewTaskRepository(db)

	for _, ref := range []string{
		"portento-999", // no such number in that channel
		"otracosa-89",  // no such channel
		"portento-",    // nothing after the hyphen
		"portento-abc", // not a number
		"89",           // no channel named at all
		"portento-0",   // sequences start at 1
	} {
		if got, err := repo.FindTask(ref); err == nil {
			t.Errorf("%q must not resolve, got %q", ref, got.ID)
		}
	}
}

// The collision the folio must not fall into.
//
// Two sequences share the same digits: a client's channel numbers its tickets,
// and an internal card numbers within its space. "portento-89" names exactly
// one of those, and resolving it to the other would open somebody else's card
// under the client's name — silently, since both are real cards with real
// titles and nothing on screen would look wrong.
func TestAFolioNeverResolvesToAnInternalCardSharingItsNumber(t *testing.T) {
	db, cleanup := commentDB(t)
	defer cleanup()
	seedThread(t, db) // portento-89 exists, project pr-1

	// An internal card with no channel, numbered 500 within its own space.
	// Deliberately a number the channel has *not* reached: if both existed, both
	// would match a query that forgot to require the channel, and which one came
	// back would be down to row order — the test would then pass or fail by luck
	// rather than by the rule it is checking.
	internal := &domain.Item{
		OrgID: "org-1", ListID: "li-9", SpaceID: "sp-9", ProjectID: "", Seq: 500,
		Title: "nota interna que no es de nadie fuera",
	}
	internal.ID = "it-internal"
	if err := db.Create(internal).Error; err != nil {
		t.Fatal(err)
	}

	repo := repository.NewTaskRepository(db)
	if found, err := repo.FindTask("portento-500"); err == nil {
		t.Fatalf("portento-500 does not exist; resolving it to %q opens internal work under the client's name", found.ID)
	}
	// And the real one still resolves, so this isn't passing by refusing everything.
	if found, err := repo.FindTask("portento-89"); err != nil || found.ID != "it-1" {
		t.Errorf("the channel's own ticket must still resolve: %v %+v", err, found)
	}
}
