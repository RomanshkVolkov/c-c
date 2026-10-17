package service

import (
	"errors"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

type recordingInbox struct{ got []domain.Aviso }

func (r *recordingInbox) Notify(a domain.Aviso) { r.got = append(r.got, a) }

func member(ids ...string) []domain.OrgMembershipClaim {
	out := make([]domain.OrgMembershipClaim, 0, len(ids))
	for _, id := range ids {
		out = append(out, domain.OrgMembershipClaim{OrgID: id})
	}
	return out
}

// En qué organización cae el aviso: la pedida si es suya; sin pedir, la única;
// con varias, ninguna.
// Mutantes: aceptar una organización ajena; con varias, quedarse con la
// primera (el aviso caería en una campana que no está mirando).
func TestTheNoticeLandsInAnOrgOfTheCaller(t *testing.T) {
	if got, err := ResolveNoticeOrg("o2", member("o1", "o2")); err != nil || got != "o2" {
		t.Errorf("la pedida y suya: %q %v", got, err)
	}
	if _, err := ResolveNoticeOrg("ajena", member("o1", "o2")); !errors.Is(err, ErrNoticeOrgNotMine) {
		t.Errorf("una ajena: %v", err)
	}
	if got, err := ResolveNoticeOrg("", member("o1")); err != nil || got != "o1" {
		t.Errorf("sin pedir y con una sola: %q %v", got, err)
	}
	if _, err := ResolveNoticeOrg("", member("o1", "o2")); !errors.Is(err, ErrNoticeOrgAmbiguous) {
		t.Errorf("sin pedir y con varias: %v", err)
	}
}

// El aviso es para quien llama y nadie más, con lo que mandó, agrupado y con
// la marca de por dónde llegó.
// Mutantes: mandarlo a otro destinatario; perder el enlace; sin grupo.
func TestASelfNoticeGoesToTheCallerOnly(t *testing.T) {
	inbox := &recordingInbox{}
	s := NewSelfNoticeService(nil, inbox, nil)
	me := &domain.ClaimsJWT{UserID: "u-jose", Orgs: member("o1")}
	_, err := s.Send(me, domain.ViaMCP, domain.SelfNoticeRequest{Title: "Paré: hay una decisión", Body: "¿v1.7.2 ya?", Link: "/tasks?item=x"})
	if err != nil {
		t.Fatal(err)
	}
	if len(inbox.got) != 1 {
		t.Fatalf("%d avisos", len(inbox.got))
	}
	a := inbox.got[0]
	if a.UserID != "u-jose" || a.OrgID != "o1" || a.Kind != domain.SelfNoticeKind || a.Link != "/tasks?item=x" ||
		a.Title != "Paré: hay una decisión" || a.Via != domain.ViaMCP || a.Group != domain.SelfNoticeGroup("u-jose") {
		t.Errorf("el aviso: %+v", a)
	}
	// Un enlace de fuera no se manda.
	if _, err := s.Send(me, "", domain.SelfNoticeRequest{Title: "x", Link: "//evil.example"}); !errors.Is(err, ErrNoticeLink) || len(inbox.got) != 1 {
		t.Errorf("con un enlace de fuera: %v, %d avisos", err, len(inbox.got))
	}
}

// Un agente en bucle no convierte la campana en una sirena: diez cada diez
// minutos, y la ventana corre.
// Mutantes: sin tope; un tope que no se vacía nunca.
func TestASelfNoticeLoopIsCapped(t *testing.T) {
	inbox := &recordingInbox{}
	s := NewSelfNoticeService(nil, inbox, nil)
	now := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	me := &domain.ClaimsJWT{UserID: "u-jose", Orgs: member("o1")}
	for i := 0; i < selfNoticeLimit; i++ {
		if _, err := s.Send(me, "", domain.SelfNoticeRequest{Title: "x"}); err != nil {
			t.Fatalf("el %d.º: %v", i+1, err)
		}
	}
	if _, err := s.Send(me, "", domain.SelfNoticeRequest{Title: "x"}); !errors.Is(err, ErrNoticeTooMany) {
		t.Fatalf("pasado el tope: %v", err)
	}
	// Otra persona tiene su propio tope.
	other := &domain.ClaimsJWT{UserID: "u-bea", Orgs: member("o1")}
	if _, err := s.Send(other, "", domain.SelfNoticeRequest{Title: "x"}); err != nil {
		t.Errorf("otra persona: %v", err)
	}
	now = now.Add(selfNoticeWindow)
	if _, err := s.Send(me, "", domain.SelfNoticeRequest{Title: "x"}); err != nil {
		t.Errorf("pasada la ventana: %v", err)
	}
	if len(inbox.got) != selfNoticeLimit+2 {
		t.Errorf("%d avisos", len(inbox.got))
	}
}
