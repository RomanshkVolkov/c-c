package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type EventsHandler interface {
	Stream(w http.ResponseWriter, r *http.Request)
}

type eventsHandler struct {
	hub *events.Hub
}

func NewEventsHandler(hub *events.Hub) EventsHandler {
	return &eventsHandler{hub: hub}
}

// Stream is the org-scoped SSE endpoint the Tauri console subscribes to. Auth is
// by ?token= (EventSource can't set Authorization) or the Authorization header.
// Events are delivered only for the orgs the caller belongs to.
func (h *eventsHandler) Stream(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
			token = strings.TrimPrefix(a, "Bearer ")
		}
	}
	claims, err := repository.ValidateAccessToken(token)
	if err != nil {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		SendErrorResponse(w, http.StatusInternalServerError, "Streaming unsupported", "no-flusher")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering
	w.WriteHeader(http.StatusOK)

	ch, unsubscribe := h.hub.Subscribe(claims.OrgIDs())
	defer unsubscribe()

	// Initial comment so the client's onopen fires immediately.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case ev, open := <-ch:
			if !open {
				return
			}
			payload, err := json.Marshal(ev.Data)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload)
			flusher.Flush()
		}
	}
}
