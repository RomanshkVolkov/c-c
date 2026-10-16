package service

import (
	"context"
	"strings"
	"testing"
	"time"

	lksdk "github.com/livekit/protocol/livekit"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// El chat de la llamada (tanda 3). Mutantes: dejar escribir con la llamada
// terminada; dejar editar lo de otro; no filtrar lo retirado; no contar el
// chat en el resumen; mandar el texto en el evento; abrir dos sesiones y dar
// a cada uno la suya.

func openCall(t *testing.T, svc *CallSessionService) *domain.CallSession {
	t.Helper()
	sp := "esp-1"
	a := svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	b := svc.Open("org-1", &sp, "voice:esp-1", nil, "u-bea")
	if a == "" || a != b {
		t.Fatalf("los dos que entran tienen que ver la misma llamada: %q %q", a, b)
	}
	cs, err := svc.Find(a)
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

func TestTheCallChatIsWrittenDuringTheCallAndReadAfter(t *testing.T) {
	svc, _, db := callsUnderTestDB(t, &fakeSFU{})
	cs := openCall(t, svc)
	if _, err := svc.PostMessage(cs, "u-ana", "ana", "  el enlace: https://x.y  "); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.NewCallSessionRepository(db).Close(cs.ID, callT0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	cs, _ = svc.Find(cs.ID)
	if _, err := svc.PostMessage(cs, "u-ana", "ana", "tarde"); err != ErrCallEnded {
		t.Errorf("con la llamada terminada el chat es de sólo lectura: %v", err)
	}
	msgs, err := svc.Messages(cs.ID, "u-ana")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Body != "el enlace: https://x.y" || msgs[0].AuthorName != "ana" {
		t.Errorf("lo dicho se lee después, tal cual: %+v", msgs)
	}
}

func TestOnlyTheAuthorChangesACallMessage(t *testing.T) {
	svc, _, _ := callsUnderTestDB(t, &fakeSFU{})
	cs := openCall(t, svc)
	m, _ := svc.PostMessage(cs, "u-ana", "ana", "lo mío")
	if err := svc.EditMessage(cs, m.ID, "u-bea", "lo cambio yo"); err != ErrNotYourCallMessage {
		t.Errorf("editar lo de otro: %v", err)
	}
	if err := svc.WithdrawMessage(cs, m.ID, "u-bea"); err != ErrNotYourCallMessage {
		t.Errorf("retirar lo de otro: %v", err)
	}
	if err := svc.EditMessage(cs, m.ID, "u-ana", "corregido"); err != nil {
		t.Fatal(err)
	}
	other := &domain.CallSession{}
	other.ID = "00000000-0000-4000-8000-000000000000"
	if err := svc.EditMessage(other, m.ID, "u-ana", "x"); err != repository.ErrCallMessageNotFound {
		t.Errorf("un mensaje de otra llamada no se toca desde ésta: %v", err)
	}
	if err := svc.WithdrawMessage(cs, m.ID, "u-ana"); err != nil {
		t.Fatal(err)
	}
	if msgs, _ := svc.Messages(cs.ID, "u-ana"); len(msgs) != 0 {
		t.Errorf("retirado, no se lee: %+v", msgs)
	}
}

// Una llamada corta de una sola persona que escribió algo sí deja resumen, y
// el resumen cuenta los mensajes.
func TestTheSummaryCountsTheChat(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{inCall("u-ana", "Ana")}}
	svc, sum, _ := callsUnderTestDB(t, sfu)
	cs := openCall(t, svc)
	if _, err := svc.PostMessage(cs, "u-ana", "ana", "apunto esto"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	svc.Tick(ctx, callT0.Add(10*time.Second))
	sfu.people = nil
	svc.Tick(ctx, callT0.Add(20*time.Second))
	svc.Tick(ctx, callT0.Add(30*time.Second))
	if len(sum.posts) != 1 || !strings.Contains(sum.posts[0], "1 message") {
		t.Errorf("lo escrito merece resumen y se cuenta: %v", sum.posts)
	}
}

// El evento dice qué llamada, no qué se dijo: llega a toda la organización.
func TestACallMessageIsAnnouncedWithoutItsText(t *testing.T) {
	svc, _, _ := callsUnderTestDB(t, &fakeSFU{})
	hub := events.NewHub()
	svc.WithHub(hub)
	hears, closeHub := hub.Subscribe("u-bea", []string{"org-1"})
	defer closeHub()
	cs := openCall(t, svc)
	if _, err := svc.PostMessage(cs, "u-ana", "ana", "secreto de la reunión"); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-hears:
		data, _ := e.Data.(map[string]any)
		if e.Type != "call:message" || data["sessionId"] != cs.ID {
			t.Fatalf("el aviso dice de qué llamada es: %s %v", e.Type, data)
		}
		for _, v := range data {
			if s, ok := v.(string); ok && strings.Contains(s, "secreto") {
				t.Errorf("el texto no viaja en el aviso: %v", data)
			}
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("quien está en la llamada no se entera del mensaje")
	}
}
