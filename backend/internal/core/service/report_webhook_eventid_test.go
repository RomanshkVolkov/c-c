package service

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// cuerposRecibidos records every raw body a receiver got, and can fail the
// first few attempts on purpose — which is the only way to see a retry.
type cuerposRecibidos struct {
	mu      sync.Mutex
	cuerpos [][]byte
	fallos  int
}

func (c *cuerposRecibidos) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cuerpo, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		c.cuerpos = append(c.cuerpos, cuerpo)
		n := len(c.cuerpos)
		c.mu.Unlock()
		if n <= c.fallos {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}
}

func (c *cuerposRecibidos) todos() []webhookPayload {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]webhookPayload, 0, len(c.cuerpos))
	for _, b := range c.cuerpos {
		var p webhookPayload
		_ = json.Unmarshal(b, &p)
		out = append(out, p)
	}
	return out
}

func (c *cuerposRecibidos) cuantos() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.cuerpos)
}

// The event id is per *event*, not per attempt.
//
// That distinction is the entire point of the field: a retry repeats the body
// byte for byte, so if the id changed each time around the loop the receiver
// still couldn't dedupe — and nothing would look broken. Duplicates only show
// up against a slow receiver in production, which is why this drives a server
// that really does fail twice instead of reading the struct.
func TestTheEventIdSurvivesRetries(t *testing.T) {
	rec := &cuerposRecibidos{fallos: 2}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	dispatchWebhook(target(srv.URL, "s3cret"), "report:comment", "rep-1",
		map[string]any{"from": "team"})

	waitFor(t, 12*time.Second, func() bool { return rec.cuantos() >= webhookAttempts })

	llegados := rec.todos()
	if len(llegados) != webhookAttempts {
		t.Fatalf("got %d attempts, want %d", len(llegados), webhookAttempts)
	}
	primero := llegados[0].EventID
	if primero == "" {
		t.Fatal("the payload carries no eventId")
	}
	if _, err := uuid.Parse(primero); err != nil {
		t.Fatalf("eventId is not a uuid: %q", primero)
	}
	for i, p := range llegados[1:] {
		if p.EventID != primero {
			t.Errorf("attempt %d carries a different eventId: %q != %q",
				i+2, p.EventID, primero)
		}
	}
}

// And two separate events must not share one. Without this, "generated once"
// would also be satisfied by a constant, and the test above would still pass.
func TestTwoEventsDoNotShareAnId(t *testing.T) {
	rec := &cuerposRecibidos{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	dispatchWebhook(target(srv.URL, ""), "report:new", "r-1", nil)
	dispatchWebhook(target(srv.URL, ""), "report:new", "r-2", nil)

	waitFor(t, 5*time.Second, func() bool { return rec.cuantos() >= 2 })

	llegados := rec.todos()
	if len(llegados) != 2 {
		t.Fatalf("got %d deliveries, want 2", len(llegados))
	}
	if llegados[0].EventID == llegados[1].EventID {
		t.Errorf("two events share an id: %q", llegados[0].EventID)
	}
}
