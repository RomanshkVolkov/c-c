package events

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// channel is the single Valkey pub/sub channel every pod publishes to and
// listens on. One channel rather than one per org: the org filter already lives
// in the subscriber list, and a channel per org would mean re-subscribing every
// time somebody with a different membership connects.
const channel = "cac:events"

// wireEvent is the on-the-wire shape. Event.OrgID is `json:"-"` because it must
// never reach a client; across the bus it is the whole point, so it travels in
// its own envelope instead.
type wireEvent struct {
	Type  string `json:"type"`
	OrgID string `json:"orgId"`
	// UserID travels too, or an event addressed to one person would arrive on
	// another pod as an ordinary org-wide broadcast — which is exactly the leak
	// the field exists to prevent, and it would only show up with more than one
	// replica.
	UserID string          `json:"userId,omitempty"`
	Data   json.RawMessage `json:"data"`
}

type bus struct {
	rdb       *redis.Client
	connected atomic.Bool
}

// UseBus points the hub at a shared bus so events reach subscribers on every
// pod. An empty addr leaves the hub per-pod, which is what a single-process
// deployment and the tests want.
//
// Address and password are separate rather than one redis:// URL on purpose: a
// URL carries the credential inside a string that gets copied into config,
// error messages and logs, and this codebase already had to go back and redact
// tokens out of its access log once.
//
// Never returns an error for a Valkey that is merely down. The subscription
// loop keeps retrying and Publish falls back to local delivery meanwhile, so an
// outage costs cross-pod delivery rather than the whole feature.
func (h *Hub) UseBus(addr, password string) {
	if addr == "" {
		return
	}
	b := &bus{rdb: redis.NewClient(&redis.Options{Addr: addr, Password: password})}
	h.bus = b
	go b.listen(h)
}

func (b *bus) ready() bool { return b.connected.Load() }

// encodeEvent and decodeEvent are the wire format, pulled out of publish and
// the listen loop so they can be tested without a running bus.
//
// The tests that exercise the real bus skip when there is no Valkey to talk to,
// which left the one field that must not be dropped — UserID — covered by
// nothing at all. Production runs two replicas, so the cross-pod path is the
// normal path, and losing the address there turns a private message into an
// org-wide broadcast on every pod but the sender's.
func encodeEvent(e Event) ([]byte, error) {
	data, err := json.Marshal(e.Data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(wireEvent{Type: e.Type, OrgID: e.OrgID, UserID: e.UserID, Data: data})
}

func decodeEvent(payload []byte) (Event, error) {
	var w wireEvent
	if err := json.Unmarshal(payload, &w); err != nil {
		return Event{}, err
	}
	var data any
	_ = json.Unmarshal(w.Data, &data)
	return Event{Type: w.Type, OrgID: w.OrgID, UserID: w.UserID, Data: data}, nil
}

func (b *bus) publish(e Event) error {
	payload, err := encodeEvent(e)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return b.rdb.Publish(ctx, channel, payload).Err()
}

// listen keeps a subscription open and hands everything it receives to the
// hub's local subscribers — including what this pod published, which is why
// Publish does not deliver locally when the bus is up.
func (b *bus) listen(h *Hub) {
	ctx := context.Background()
	for {
		sub := b.rdb.Subscribe(ctx, channel)
		// Ping the subscription so a broken Valkey is noticed here rather than
		// by the first event that goes missing.
		if _, err := sub.Receive(ctx); err != nil {
			b.connected.Store(false)
			lg.Warn("events: bus unreachable, delivering per-pod: " + err.Error())
			_ = sub.Close()
			time.Sleep(5 * time.Second)
			continue
		}
		b.connected.Store(true)
		lg.Info("events: shared bus connected")

		for msg := range sub.Channel() {
			e, err := decodeEvent([]byte(msg.Payload))
			if err != nil {
				continue // a malformed frame is not worth dropping the stream for
			}
			h.deliver(e)
		}

		// Channel closed: the connection dropped. Mark it and reconnect.
		b.connected.Store(false)
		_ = sub.Close()
		time.Sleep(time.Second)
	}
}
