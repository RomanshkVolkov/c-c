// Package events is a pub/sub hub for org-scoped SSE notifications. Subscribers
// (the cac app) receive only events for orgs they belong to.
//
// Delivery is in-memory per process, which was silently wrong the moment the
// deployment ran more than one replica: a console connected to pod A never saw
// anything published on pod B, so new reports arrived with no notification and
// no refresh. With two replicas and a tenant posting over a keep-alive
// connection — always landing on the same pod — that isn't half the events, it
// is all of them.
//
// So a Hub can be given a shared bus (Valkey). When it has one, every event
// goes out over the bus and comes back in through the subscription loop, on
// every pod including the one that published it. One path, so nothing is
// delivered twice. Without a bus, or while it is unreachable, Publish delivers
// locally — which is exactly the old behaviour, and the right way to degrade.
package events

import "sync"

// Event is one notification. OrgID scopes delivery; Data is the JSON payload.
type Event struct {
	Type  string `json:"type"`
	OrgID string `json:"-"`
	// UserID addresses one person instead of an organization.
	//
	// Everything else here is org-wide by nature — a board moved, a report
	// arrived — and a superadmin's console deliberately sees all of it. A direct
	// message is the first thing that is nobody's business but its two
	// participants', so when this is set it *narrows* delivery rather than
	// widening it, and that includes cutting the superadmin out. See deliver().
	UserID string `json:"-"`
	Data   any    `json:"data"`
}

type subscriber struct {
	orgs   map[string]bool
	all    bool   // superadmin: receive events from every org
	userID string // who is listening, for events addressed to one person
	ch     chan Event
}

type Hub struct {
	mu   sync.RWMutex
	subs map[int]*subscriber
	next int
	bus  *bus // nil until UseBus succeeds; nil means per-pod delivery
}

func NewHub() *Hub {
	return &Hub{subs: make(map[int]*subscriber)}
}

// Subscribe registers a listener for the given orgs and returns its channel plus
// an unsubscribe func. The channel is buffered; a slow consumer drops events
// rather than blocking publishers.
func (h *Hub) Subscribe(userID string, orgIDs []string) (<-chan Event, func()) {
	return h.subscribe(userID, orgIDs, false)
}

// SubscribeAll registers a listener that receives events from every org. Used by
// superadmins, whose console spans all organizations.
func (h *Hub) SubscribeAll(userID string) (<-chan Event, func()) {
	return h.subscribe(userID, nil, true)
}

func (h *Hub) subscribe(userID string, orgIDs []string, all bool) (<-chan Event, func()) {
	orgs := make(map[string]bool, len(orgIDs))
	for _, id := range orgIDs {
		orgs[id] = true
	}
	sub := &subscriber{orgs: orgs, all: all, userID: userID, ch: make(chan Event, 32)}

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
// Publish sends an event to every subscriber that should see it, on this pod
// and on the others.
func (h *Hub) Publish(e Event) {
	if h.bus != nil && h.bus.ready() {
		if err := h.bus.publish(e); err == nil {
			return // comes back through the subscription loop, here too
		}
		// Bus hiccup: fall through and at least reach this pod's subscribers.
	}
	h.deliver(e)
}

// deliver fans an event out to this process's subscribers.
func (h *Hub) deliver(e Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.subs {
		// Addressed to one person: nobody else, whatever they are subscribed
		// to. Checked before the org rule on purpose — `all` means "every
		// organization", not "every conversation", and reading it as the latter
		// would put private messages on a superadmin's stream.
		if e.UserID != "" {
			if s.userID != e.UserID {
				continue
			}
		} else if !s.all && !s.orgs[e.OrgID] {
			continue
		}
		select {
		case s.ch <- e:
		default: // slow consumer — drop rather than block
		}
	}
}
