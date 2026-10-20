package events

import "testing"

// Lo que es de todas las organizaciones —un comunicado, una publicación del
// muro «para todos»— llega a todo el que escucha, y también a través del bus;
// un evento con dirección sigue yendo sólo a su persona. Mutantes: no mirar
// Broadcast en deliver; perderlo en el bus; que Broadcast le gane a UserID.
func TestABroadcastReachesEveryoneAndSurvivesTheBus(t *testing.T) {
	h := NewHub()
	ana, unsubA := h.Subscribe("u-ana", []string{"org-1"})
	defer unsubA()
	dani, unsubD := h.Subscribe("u-dani", []string{"org-2"})
	defer unsubD()
	nadie, unsubN := h.Subscribe("u-sin-org", nil)
	defer unsubN()

	h.Publish(Event{Type: "post:new", Broadcast: true, Data: map[string]string{"id": "p-1"}})
	for name, ch := range map[string]<-chan Event{"ana": ana, "dani": dani, "sin org": nadie} {
		if e := recv(t, ch); e == nil || e.Type != "post:new" {
			t.Fatalf("%s no recibió el evento para todos", name)
		}
	}

	h.Publish(Event{Type: "dm:message", Broadcast: true, UserID: "u-ana", Data: nil})
	if recv(t, dani) != nil {
		t.Fatal("un evento con dirección y Broadcast llegó a otra persona")
	}
	if recv(t, ana) == nil {
		t.Fatal("el destinatario no lo recibió")
	}

	raw, err := encodeEvent(Event{Type: "post:new", Broadcast: true, Data: 1})
	if err != nil {
		t.Fatal(err)
	}
	back, err := decodeEvent(raw)
	if err != nil || !back.Broadcast {
		t.Fatalf("Broadcast no sobrevive al bus: %+v %v", back, err)
	}
}
