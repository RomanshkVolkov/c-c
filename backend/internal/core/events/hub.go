// Package events is an in-memory pub/sub hub for org-scoped SSE notifications.
// Subscribers (the Tauri console) receive only events for orgs they belong to.
// In-memory means events are per-pod: with multiple replicas a client connected
// to pod A won't see events published on pod B. Fine for the console at this
// scale; revisit with a shared bus (Valkey/NATS) if it becomes a problem.
package events

import "sync"

// Event is one notification. OrgID scopes delivery; Data is the JSON payload.
type Event struct {
	Type  string `json:"type"`
	OrgID string `json:"-"`
	Data  any    `json:"data"`
}

type subscriber struct {
	orgs map[string]bool
	ch   chan Event
}

type Hub struct {
	mu   sync.RWMutex
	subs map[int]*subscriber
	next int
}

func NewHub() *Hub {
	return &Hub{subs: make(map[int]*subscriber)}
}

// Subscribe registers a listener for the given orgs and returns its channel plus
// an unsubscribe func. The channel is buffered; a slow consumer drops events
// rather than blocking publishers.
func (h *Hub) Subscribe(orgIDs []string) (<-chan Event, func()) {
	orgs := make(map[string]bool, len(orgIDs))
	for _, id := range orgIDs {
		orgs[id] = true
	}
	sub := &subscriber{orgs: orgs, ch: make(chan Event, 32)}

	h.mu.Lock()
	id := h.next
	h.next++
	h.subs[id] = sub
	h.mu.Unlock()

	return sub.ch, func() {
		h.mu.Lock()
		if s, ok := h.subs[id]; ok {
			delete(h.subs, id)
			close(s.ch)
		}
		h.mu.Unlock()
	}
}

// Publish fans an event out to every subscriber of its org. Non-blocking: if a
// subscriber's buffer is full the event is dropped for that subscriber only.
func (h *Hub) Publish(e Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.subs {
		if !s.orgs[e.OrgID] {
			continue
		}
		select {
		case s.ch <- e:
		default: // slow consumer — drop rather than block
		}
	}
}
