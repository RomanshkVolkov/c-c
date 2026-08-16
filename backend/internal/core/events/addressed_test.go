package events

import (
	"testing"
	"time"
)

// An event addressed to one person.
//
// Every other event here is org-wide by nature — a card moved, a report
// arrived — and a superadmin's console is *meant* to see all of it. A direct
// message is the first thing that is nobody's business but its two
// participants', so this field narrows delivery instead of widening it.
//
// The superadmin case is the whole point. `all: true` means "every
// organization", and reading it as "every conversation" would put private
// messages on their stream — a leak nobody would notice, because it would look
// exactly like the console working.

func recv(t *testing.T, ch <-chan Event) *Event {
	t.Helper()
	select {
	case e := <-ch:
		return &e
	case <-time.After(150 * time.Millisecond):
		return nil
	}
}

func TestAnAddressedEventReachesOnlyItsPerson(t *testing.T) {
	h := NewHub()
	ana, unsubA := h.Subscribe("u-ana", []string{"org-1"})
	defer unsubA()
	bea, unsubB := h.Subscribe("u-bea", []string{"org-1"})
	defer unsubB()
	root, unsubR := h.SubscribeAll("u-root")
	defer unsubR()

	h.Publish(Event{Type: "dm:message", OrgID: "org-1", UserID: "u-bea", Data: map[string]string{"x": "1"}})

	if got := recv(t, bea); got == nil {
		t.Error("the person it was addressed to did not get it")
	}
	if got := recv(t, ana); got != nil {
		t.Error("a colleague in the same organization must not receive somebody's private message")
	}
	if got := recv(t, root); got != nil {
		t.Error("a superadmin subscribed to everything must not receive it either — 'every org' is not 'every conversation'")
	}
}

// And nothing about the ordinary path changes: without an address, an event is
// still everyone-in-the-org's, superadmin included.
func TestWithoutAnAddressTheOrgStillGetsEverything(t *testing.T) {
	h := NewHub()
	ana, unsubA := h.Subscribe("u-ana", []string{"org-1"})
	defer unsubA()
	root, unsubR := h.SubscribeAll("u-root")
	defer unsubR()
	other, unsubO := h.Subscribe("u-otro", []string{"org-2"})
	defer unsubO()

	h.Publish(Event{Type: "task:update", OrgID: "org-1", Data: map[string]string{"x": "1"}})

	if recv(t, ana) == nil {
		t.Error("the org's own subscriber should still receive org events")
	}
	if recv(t, root) == nil {
		t.Error("a superadmin should still receive them")
	}
	if recv(t, other) != nil {
		t.Error("another organization should not")
	}
}

// The address has to survive the trip between pods.
//
// This is the path production actually uses — the deployment runs two
// replicas — and it is the one the bus tests cannot cover, because they need a
// Valkey to talk to and skip without one. Drop UserID here and a direct message
// arrives on the other pod looking like an ordinary organization broadcast:
// delivered to everybody, including a superadmin, with nothing to signal it.
func TestTheAddressSurvivesTheWire(t *testing.T) {
	in := Event{
		Type: "dm:message", OrgID: "org-1", UserID: "u-bea",
		Data: map[string]string{"conversationId": "c-1"},
	}
	payload, err := encodeEvent(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := decodeEvent(payload)
	if err != nil {
		t.Fatal(err)
	}
	if out.UserID != "u-bea" {
		t.Errorf("the address was lost crossing the bus: %+v", out)
	}
	if out.Type != in.Type || out.OrgID != in.OrgID {
		t.Errorf("the rest of the event should survive too: %+v", out)
	}
}
