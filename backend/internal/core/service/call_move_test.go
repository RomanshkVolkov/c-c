package service

import (
	"context"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
)

// Invitar a alguien de fuera desde dentro de la llamada del canal **muda la
// llamada**: quienes están se vienen detrás, y quien entra en los siguientes
// treinta segundos acaba en la reunión y no solo en el canal. Antes sólo se
// iba quien creaba el enlace, y había que decirle a cada uno «muévete» (jose,
// 15-oct-2026).
//
// Mutantes: no avisar; avisar sin mudarse; no mirar la ventana; mudar una
// invitación cerrada; mudarse sin canal.

func TestMovingTheCallTellsWhoIsInIt(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	hub := events.NewHub()
	svc.WithHub(hub)
	oye, cerrar := hub.Subscribe("u-bea", []string{"org-1"})
	defer cerrar()

	inv, err := svc.Create("org-1", strp("sp-1"), "u-host", "Con el cliente", 0, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-oye:
		datos, _ := e.Data.(map[string]any)
		if e.Type != "voice.moved" || datos["spaceId"] != "sp-1" || datos["inviteId"] != inv.ID || datos["actorId"] != "u-host" {
			t.Fatalf("el aviso tiene que decir de qué canal a qué reunión y quién; %s %v", e.Type, datos)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("quien está en la llamada no se entera de que se mudó")
	}

	// Una invitación corriente, desde el canal pero no desde la llamada, no
	// muda a nadie.
	if _, err := svc.Create("org-1", strp("sp-1"), "u-host", "Otra", 0, 0, false); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-oye:
		t.Fatalf("una invitación que no muda la llamada no avisa de mudanza: %s", e.Type)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestWhoArrivesLateFollowsTheMove(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv, err := svc.Create("org-1", strp("sp-1"), "u-host", "Con el cliente", 0, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if m := svc.MovedCallFor("sp-1"); m == nil || m.InviteID != inv.ID || m.Title != "Con el cliente" {
		t.Fatalf("quien entra justo después tiene que acabar en la reunión; %+v", m)
	}
	if m := svc.MovedCallFor("sp-otro"); m != nil {
		t.Errorf("otro canal no se mudó; %+v", m)
	}

	// Pasada la ventana, el canal vuelve a ser el canal.
	real := svc.now
	svc.now = func() time.Time { return real().Add(domain.CallMoveWindow + time.Second) }
	if m := svc.MovedCallFor("sp-1"); m != nil {
		t.Errorf("pasados %v ya no se redirige a nadie; %+v", domain.CallMoveWindow, m)
	}
	svc.now = real

	// Y una reunión cerrada no se lleva a nadie.
	if err := svc.Revoke(context.Background(), inv); err != nil {
		t.Fatal(err)
	}
	if m := svc.MovedCallFor("sp-1"); m != nil {
		t.Errorf("cerrada, no se manda a nadie a una sala que ya no abre; %+v", m)
	}
}

func TestOnlyAChannelCallCanMove(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv, err := svc.Create("org-1", nil, "u-host", "Sin canal", 0, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if inv.MovedAt != nil {
		t.Error("sin canal no hay llamada de la que mudarse")
	}
}
