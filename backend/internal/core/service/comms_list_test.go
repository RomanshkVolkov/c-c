package service

import (
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// La lista de canales y directos como en WhatsApp: debajo del nombre, la
// última línea; y en lo tuyo de un directo, si el otro ya lo leyó.
//
// Mutantes: tomar la primera línea en vez de la última; contar una retirada;
// cruzar de organización; leer la marca de lectura propia en vez de la del
// otro; avisar de la lectura a quien lee, o a nadie.

func TestEachChannelShowsItsLatestLine(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)

	if _, err := svc.Post("esp-1", "org-1", ana, "primero"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := svc.Post("esp-1", "org-1", bea, "lo último que queda"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	gone, _ := svc.Post("esp-1", "org-1", bea, "esto se retira")
	if err := svc.Withdraw(gone.ID, bea, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Post("esp-2", "org-1", caro, "en el otro canal"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Post("esp-otra", "org-2", "44444444-4444-4444-8444-444444444444", "de otra org"); err != nil {
		t.Fatal(err)
	}

	got, err := svc.Latest([]string{"org-1"}, false)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]domain.ChatLatest{}
	for _, l := range got {
		by[l.SpaceID] = l
	}
	if len(by) != 2 {
		t.Fatalf("un canal por fila y sólo de mis orgs: %+v", got)
	}
	if l := by["esp-1"]; l.Body != "lo último que queda" || l.AuthorUserID != bea || l.AuthorName != "bea" {
		t.Errorf("la última línea viva, con quién la escribió: %+v", l)
	}
	if by["esp-2"].Body != "en el otro canal" {
		t.Errorf("cada canal la suya: %+v", by["esp-2"])
	}
}

func TestTheDMListShowsTheLastLineAndHowFarTheOtherRead(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	hub := events.NewHub()
	svc := NewDMService(repo, hub)
	c, _ := repo.OpenWith("org-1", "u-ana", "u-bea")

	if _, err := svc.Post(c.ID, "u-ana", "¿vienes?"); err != nil {
		t.Fatal(err)
	}
	mine := func() domain.DMSummary {
		t.Helper()
		list, err := repo.Conversations("u-ana", []string{"org-1"})
		if err != nil || len(list) != 1 {
			t.Fatalf("la conversación: %v %v", list, err)
		}
		return list[0]
	}
	if s := mine(); s.LastBody != "¿vienes?" || s.LastAuthorID != "u-ana" || s.OtherReadAt != nil {
		t.Fatalf("lo último es lo mío y el otro no ha leído nada: %+v", s)
	}

	anaHears, closeAna := hub.Subscribe("u-ana", nil)
	defer closeAna()
	beaHears, closeBea := hub.Subscribe("u-bea", nil)
	defer closeBea()
	if err := svc.MarkRead(c.ID, "u-bea"); err != nil {
		t.Fatal(err)
	}
	if s := mine(); s.OtherReadAt == nil {
		t.Error("bea leyó: la lista de ana lo sabe")
	}
	select {
	case e := <-anaHears:
		if e.Type != "dm:read" {
			t.Errorf("a ana le llega que bea leyó, no %q", e.Type)
		}
	case <-time.After(300 * time.Millisecond):
		t.Error("ana no se entera de que bea leyó: sus palomitas no cambiarían")
	}
	select {
	case e := <-beaHears:
		t.Errorf("a quien lee no se le cuenta que leyó: %q", e.Type)
	case <-time.After(100 * time.Millisecond):
	}

	if _, err := svc.Post(c.ID, "u-bea", "voy"); err != nil {
		t.Fatal(err)
	}
	if s := mine(); s.LastBody != "voy" || s.LastAuthorID != "u-bea" {
		t.Errorf("ahora lo último es de bea: %+v", s)
	}
}
