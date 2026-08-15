package service

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// The folio the board shows, and the one it must refuse to invent.
//
// A folio names a number in a *client's* sequence. Inside cac an item with no
// channel is numbered within its space instead, so the two sequences overlap
// freely: space-seq 12 and portento-12 are different things that happen to
// share a digit. Calling an internal card "portento-12" would therefore not be
// a cosmetic slip — it would name somebody else's ticket.
//
// Which sequence applies is decided by ProjectID at creation (see CreateTask),
// so that is what the detail keys off too. Anything else would be a second
// opinion about the same question.
func TestOnlyAClientsTicketGetsAFolio(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), repository.NewOrganizationRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	// Raised in the client's list and visible to them: theirs, so it is named.
	theirs, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{Title: "lo ven"})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := svc.Detail(theirs.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := domain.Folio("cliente", theirs.Seq)
	if detail.Folio != want {
		t.Errorf("a client's ticket must carry its folio: got %q, want %q", detail.Folio, want)
	}
	if detail.ProjectSlug != "cliente" {
		t.Errorf("the channel it belongs to should travel with it: %q", detail.ProjectSlug)
	}

	// Raised in the same list but kept internal: no channel, so it numbers per
	// space and there is no folio to give it.
	mine, err := svc.CreateTask(list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "no lo ven", Visibility: domain.VisibilityInternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	internal, err := svc.Detail(mine.ID)
	if err != nil {
		t.Fatal(err)
	}
	if internal.Folio != "" {
		t.Errorf("an internal card must not be named in the client's sequence: got %q", internal.Folio)
	}
	if internal.ProjectSlug != "" {
		t.Errorf("nor claim their channel: got %q", internal.ProjectSlug)
	}
}
