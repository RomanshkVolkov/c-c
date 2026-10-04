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

	// Bea is, and finds her own — the one of this org only. She also says
	// «secreto» to Carla in org-2, and that one belongs to the palette of org-2.
	suyo, _ := svc.Search("secreto", "org-1", "u-bea", 0)
	if len(suyo.DMs) != 1 || suyo.DMs[0].ID != "dm-1" {
		t.Errorf("Bea should find her own message of org-1 only, got %+v", suyo.DMs)
	}
}

// Cada resultado dice de qué org es, para que la app lo abra en la suya.
func TestEverySearchHitSaysItsOrganization(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	svc := NewSearchService(repository.NewSearchRepository(db))

	res, err := svc.Search("secreto", "org-2", "u-bea", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.DMs) != 1 || res.DMs[0].OrgID != "org-2" {
		t.Errorf("the org-2 DM should come back saying org-2, got %+v", res.DMs)
	}
	tareas, _ := svc.Search("tarea", "org-1", "u-ana", 0)
	if len(tareas.Tasks) == 0 || tareas.Tasks[0].OrgID != "org-1" {
		t.Errorf("a task hit should say its org, got %+v", tareas.Tasks)
	}
	notas, _ := svc.Search("apunte", "org-1", "u-ana", 0)
	if len(notas.Notes) != 1 || notas.Notes[0].OrgID != "" {
		t.Errorf("a note belongs to no org and must not claim one, got %+v", notas.Notes)
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

// Sin org se busca en las orgs que se le pasan —las del token— y en ninguna
// otra; lo de varias se junta sin repetir (las notas salen en cada una).
func TestSearchingSeveralOrgsOnlyLooksAtThoseOrgs(t *testing.T) {
	db, cleanup := searchDB(t)
	defer cleanup()
	// Una tarea en la org-2, para que haya algo que no se debe ver.
	sp := &domain.TaskSpace{OrgID: "org-2", Name: "Otro", Rank: "0.5"}
	sp.ID = "space-2"
	li := &domain.TaskList{SpaceID: "space-2", Name: "Otra lista", Rank: "0.5"}
	li.ID = "list-2"
	it := &domain.Item{OrgID: "org-2", ListID: "list-2", Title: "Una tarea ajena", Status: domain.ReportPending}
	it.ID = "it-2"
	for _, m := range []any{sp, li, it} {
		if err := db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := NewSearchService(repository.NewSearchRepository(db))

	solo1, err := svc.SearchOrgs("tarea", []string{"org-1"}, "u-ana", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(solo1.Tasks) != 1 || solo1.Tasks[0].ID != "it-1" {
		t.Errorf("con la org-1, sólo su tarea: %+v", solo1.Tasks)
	}
	ambas, _ := svc.SearchOrgs("tarea", []string{"org-1", "org-2"}, "u-ana", 0)
	if len(ambas.Tasks) != 2 {
		t.Errorf("con las dos, las dos tareas: %+v", ambas.Tasks)
	}
	ninguna, _ := svc.SearchOrgs("tarea", nil, "u-ana", 0)
	if len(ninguna.Tasks) != 0 || len(ninguna.Notes) != 0 {
		t.Errorf("sin orgs, nada: %+v", ninguna)
	}
	notas, _ := svc.SearchOrgs("apunte", []string{"org-1", "org-2"}, "u-ana", 0)
	if len(notas.Notes) != 1 {
		t.Errorf("la nota salió %d veces, se esperaba una", len(notas.Notes))
	}
	tope, _ := svc.SearchOrgs("tarea", []string{"org-1", "org-2"}, "u-ana", 1)
	if len(tope.Tasks) != 1 {
		t.Errorf("con límite 1 salieron %d tareas", len(tope.Tasks))
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
	// This list is the **search query's footprint**, not the data these cases
	// write: docs and folders are here because `SearchDocs` joins `doc_tabs`,
	// `docs` and `task_folders`, even though nothing below creates one. So it
	// has to move whenever search grows a source.
	//
	// It didn't, twice: docs and folders were missing since the day documents
	// landed, and the test failed on every run — except that it never ran. It
	// skips without a database, and CI has never had one (card #38).
	//
	// Y una tercera, el 28-sep-2026: buscar tareas empezó a mirar sus
	// comentarios (#89) y faltaba `item_comments`. Esta vez lo cazó la suite en
	// local, antes de empujar.
	if err := db.AutoMigrate(
		&domain.Organization{}, &domain.User{}, &domain.OrgMembership{},
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.Item{},
		&domain.ItemComment{},
		&domain.Note{}, &domain.ChatMessage{},
		&domain.DMConversation{}, &domain.DMMessage{},
		&domain.Doc{}, &domain.DocTab{},
	); err != nil {
		t.Fatal(err)
	}

	org := &domain.Organization{Name: "Uno", Slug: "uno"}
	org.ID = "org-1"
	sp := &domain.TaskSpace{OrgID: "org-1", Name: "Espacio", Rank: "0.5"}
	sp.ID = "space-1"
	li := &domain.TaskList{SpaceID: "space-1", Name: "Lista", Rank: "0.5"}
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
	// Las mismas dos personas en otra org: otra conversación, y la búsqueda de
	// una org no puede enseñar la de la otra.
	org2 := &domain.Organization{Name: "Dos", Slug: "dos"}
	org2.ID = "org-2"
	conv2 := &domain.DMConversation{OrgID: "org-2", UserLoID: "u-bea", UserHiID: "u-carla"}
	conv2.ID = "conv-2"
	dm2 := &domain.DMMessage{ConversationID: "conv-2", OrgID: "org-2", AuthorUserID: "u-bea", Body: "otro secreto"}
	dm2.ID = "dm-2"
	for _, m := range []any{org, org2, sp, li, it, nota, msg, conv, dm, conv2, dm2} {
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
