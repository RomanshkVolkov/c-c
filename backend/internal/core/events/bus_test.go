package events

import (
	"os"
	"testing"
	"time"
)

// busURL points at a throwaway Valkey. Skips when there isn't one, so
// `go test ./...` stays green on a machine without it.
func busAddr(t *testing.T) string {
	t.Helper()
	addr := os.Getenv("VALKEY_TEST_ADDR")
	if addr == "" {
		t.Skip("no VALKEY_TEST_ADDR")
	}
	return addr
}

func waitReady(t *testing.T, h *Hub) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if h.bus != nil && h.bus.ready() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the bus never reported ready")
}

// The property that was broken in production: two pods, a client on one and the
// event published on the other. With two replicas and a tenant posting over a
// keep-alive connection, the console never saw a new report at all.
func TestAnEventPublishedOnOnePodReachesASubscriberOnAnother(t *testing.T) {
	addr := busAddr(t)
	podA, podB := NewHub(), NewHub()
	podA.UseBus(addr, "")
	podB.UseBus(addr, "")
	waitReady(t, podA)
	waitReady(t, podB)

	ch, unsub := podB.Subscribe("", []string{"org-1"})
	defer unsub()

	podA.Publish(Event{Type: "report:new", OrgID: "org-1", Data: map[string]any{"folio": "portento-9"}})

	select {
	case ev := <-ch:
		if ev.Type != "report:new" {
			t.Errorf("got %q", ev.Type)
		}
		data, _ := ev.Data.(map[string]any)
		if data["folio"] != "portento-9" {
			t.Errorf("payload did not survive the trip: %v", ev.Data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the subscriber on the other pod never received it")
	}
}

// The publishing pod's own subscribers must get it exactly once. Delivering
// locally *and* over the bus is the obvious way to write this and it shows up
// as duplicated toasts.
func TestThePublishingPodDeliversOnceNotTwice(t *testing.T) {
	addr := busAddr(t)
	h := NewHub()
	h.UseBus(addr, "")
	waitReady(t, h)

	ch, unsub := h.Subscribe("", []string{"org-1"})
	defer unsub()

	h.Publish(Event{Type: "report:new", OrgID: "org-1"})

	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("the publishing pod's own subscriber never received it")
	}
	select {
	case ev := <-ch:
		t.Errorf("delivered twice: %+v", ev)
	case <-time.After(500 * time.Millisecond):
	}
}

// The org filter has to survive the round trip, or the bus turns an org-scoped
// stream into a broadcast — every tenant's reports on everyone's console.
func TestTheOrgFilterSurvivesTheBus(t *testing.T) {
	addr := busAddr(t)
	podA, podB := NewHub(), NewHub()
	podA.UseBus(addr, "")
	podB.UseBus(addr, "")
	waitReady(t, podA)
	waitReady(t, podB)

	mine, unsub := podB.Subscribe("", []string{"org-mine"})
	defer unsub()

	podA.Publish(Event{Type: "report:new", OrgID: "org-somebody-else"})
	podA.Publish(Event{Type: "report:new", OrgID: "org-mine"})

	select {
	case ev := <-mine:
		if ev.OrgID != "org-mine" {
			t.Errorf("received an event for %q — the bus leaked another org", ev.OrgID)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("never received my own org's event")
	}
}

// No bus configured is not a failure: one process is the whole world in dev and
// in the tests, and delivery has to keep working.
func TestWithoutABusDeliveryStaysLocal(t *testing.T) {
	h := NewHub()
	h.UseBus("", "")
	ch, unsub := h.Subscribe("", []string{"org-1"})
	defer unsub()

	h.Publish(Event{Type: "report:new", OrgID: "org-1"})
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("a hub with no bus stopped delivering")
	}
}
