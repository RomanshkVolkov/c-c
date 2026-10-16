package service

import (
	"context"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una tarjeta que nace ya en el tablero de un cliente se le anuncia con
// `report:new`, como promete server-to-server.md §5.b. Hasta el 16-oct-2026
// sólo salía al publicar una interna después: creada visible, el cliente la
// veía en su tablero sin que su webhook se enterara. Mutantes: no anunciar al
// crear; no anunciar al publicar después.
//
// «Anunciar siempre al crear» sobrevive y es **equivalente**: una interna o
// una subtarea nacen sin `ProjectID`, y sin proyecto `emitItemEvent` no
// encuentra destino. La condición de `CreateTask` es la segunda capa; la
// primera es el canal vacío.

func reportNews(t *testing.T, ch <-chan events.Event) int {
	t.Helper()
	n := 0
	for {
		select {
		case e := <-ch:
			if e.Type == "report:new" {
				n++
			}
		case <-time.After(250 * time.Millisecond):
			return n
		}
	}
}

func TestATaskBornOnAClientsBoardIsAnnounced(t *testing.T) {
	db, cleanup := visibilityDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)
	hub := events.NewHub()
	hears, closeHub := hub.Subscribe("u-observer", []string{"org-1"})
	defer closeHub()
	svc := NewTaskService(repo, repository.NewReportRepository(db), repository.NewOrganizationRepository(db), hub)
	list, err := repo.FindList("list-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.BindListToChannel("list-1", "proj-1"); err != nil {
		t.Fatal(err)
	}

	parent, err := svc.CreateTask(context.Background(), list, "org-1", "u-1", domain.CreateTaskRequest{Title: "visible desde el principio"})
	if err != nil {
		t.Fatal(err)
	}
	if n := reportNews(t, hears); n != 1 {
		t.Fatalf("nacida en el tablero del cliente, un report:new; salieron %d", n)
	}

	internal, err := svc.CreateTask(context.Background(), list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "nuestra", Visibility: domain.VisibilityInternal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateTask(context.Background(), list, "org-1", "u-1", domain.CreateTaskRequest{
		Title: "una línea del checklist", ParentID: parent.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if n := reportNews(t, hears); n != 0 {
		t.Errorf("ni una interna ni una subtarea se le anuncian al cliente; salieron %d", n)
	}

	// Y la interna, publicada después, también se anuncia: el mismo aviso por
	// el otro camino.
	public := domain.VisibilityPublic
	if err := svc.UpdateTask(context.Background(), internal.ID, "u-1", domain.UpdateTaskRequest{Visibility: &public}); err != nil {
		t.Fatal(err)
	}
	if n := reportNews(t, hears); n != 1 {
		t.Errorf("publicada después, un report:new; salieron %d", n)
	}
}
