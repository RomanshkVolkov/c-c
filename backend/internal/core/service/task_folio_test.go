package service

import (
	"context"
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
	theirs, err := svc.CreateTask(context.Background(), list, "org-1", "u-1", domain.CreateTaskRequest{Title: "lo ven"})
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
	// Su referencia para un commit es el folio (cac#203).
	if detail.Ref != want {
		t.Errorf("a client's ticket is referenced by its folio: got %q, want %q", detail.Ref, want)
	}

	// Raised in the same list but kept internal: no channel, so it numbers per
	// space and there is no folio to give it.
	mine, err := svc.CreateTask(context.Background(), list, "org-1", "u-1", domain.CreateTaskRequest{
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
	// Una interna se nombra por la clave de su espacio (cac#203). Rotura que
	// detecta: darle el folio del cliente, o ninguna referencia.
	if err := db.Model(&domain.TaskSpace{}).Where("id = ?", list.SpaceID).Update("key", "cliente-int").Error; err != nil {
		t.Fatal(err)
	}
	internal, _ = svc.Detail(mine.ID)
	if want := domain.SpaceTaskRef("cliente-int", mine.Seq); internal.Ref != want {
		t.Errorf("an internal card is referenced by its space key: got %q, want %q", internal.Ref, want)
	}
}

// Cambiar la clave de un espacio por el PATCH (cac#203). Roturas que detecta:
// ignorar `key`; o renombrar el espacio aunque la clave no valga, dejando un
// cambio a medias.
func TestRenamingASpaceCanChangeItsKey(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.SpaceKeyAlias{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewTaskRepository(db)
	svc := NewTaskService(repo, repository.NewReportRepository(db), repository.NewOrganizationRepository(db), nil)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	bad := "Mala Clave"
	if err := svc.RenameSpace(list.SpaceID, domain.RenameRequest{Name: "Nuevo nombre", Key: &bad}); err == nil {
		t.Fatal("aceptó una clave mal formada")
	}
	sp, _ := repo.FindSpace(list.SpaceID)
	if sp.Name == "Nuevo nombre" {
		t.Error("renombró aunque la clave no valía")
	}
	good := "pocna"
	if err := svc.RenameSpace(list.SpaceID, domain.RenameRequest{Name: "Nuevo nombre", Key: &good}); err != nil {
		t.Fatal(err)
	}
	sp, _ = repo.FindSpace(list.SpaceID)
	if sp.Key != "pocna" || sp.Name != "Nuevo nombre" {
		t.Errorf("espacio: %q %q", sp.Name, sp.Key)
	}
}
