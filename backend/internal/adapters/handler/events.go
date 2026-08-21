package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type EventsHandler interface {
	Stream(w http.ResponseWriter, r *http.Request)
}

type eventsHandler struct {
	hub *events.Hub
	// seen marca que esta persona sigue por aquí, en cada latido.
	//
	// Hace falta porque **esta ruta no pasa por el AuthMiddleware**: autentica
	// por `?token=` ya que EventSource no manda cabeceras, así que el registro
	// de presencia que hace el middleware nunca la ve. Y nada más en la app
	// consulta la API por temporizador — con lo cual alguien leyendo un canal
	// sin escribir se apagaba a los pocos minutos y el punto decía «ausente» de
	// quien estaba mirando la pantalla.
	//
	// El latido es el sitio correcto: tener el stream abierto *es* tener la app
	// abierta, que es lo que un punto verde debe significar. No cuesta más
	// escrituras — `TouchLastSeen` ya se limita a una cada cinco minutos por
	// persona, y lo hace en el propio WHERE.
	seen func(userID string)
}

func NewEventsHandler(hub *events.Hub, seen func(userID string)) EventsHandler {
	return &eventsHandler{hub: hub, seen: seen}
}

// latido es cada cuánto se manda el ping y, con él, se registra la presencia.
//
// Variable y no constante sólo para que un test pueda acortarlo: esperar 25
// segundos por una aserción es un test que nadie corre. Nada en producción lo
// cambia.
var latido = 25 * time.Second

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

	// Clear the server's WriteTimeout for this long-lived stream. Without this,
	// the http.Server's 15s WriteTimeout kills the SSE connection every 15s; over
	// HTTP/2 the repeated stream resets destabilize the shared multiplexed
	// connection, making unrelated API requests hang ("backend seems down").
	if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
		// Must succeed or the server WriteTimeout kills the stream at 15s and,
		// over HTTP/2, drops the shared connection. Surface regressions loudly.
		lg.Warn("SSE: could not clear write deadline (WriteTimeout will kill the stream): " + err.Error())
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering
	w.WriteHeader(http.StatusOK)

	var ch <-chan events.Event
	var unsubscribe func()
	if claims.Superadmin {
		ch, unsubscribe = h.hub.SubscribeAll(claims.UserID)
	} else {
		ch, unsubscribe = h.hub.Subscribe(claims.UserID, claims.OrgIDs())
	}
	defer unsubscribe()

	// write returns false if the peer is gone, so the loop exits and
	// `defer unsubscribe()` runs promptly (no goroutine/subscriber leak on a
	// half-open connection that never cancels the request context).
	write := func(s string) bool {
		if _, err := fmt.Fprint(w, s); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Initial comment so the client's onopen fires immediately.
	if !write(": connected\n\n") {
		return
	}

	heartbeat := time.NewTicker(latido)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if h.seen != nil {
				h.seen(claims.UserID)
			}
			// A real named event, not an SSE comment: comment lines (": ping")
			// keep the socket warm but fire NOTHING in the browser, so a client
			// can't tell a live stream from a half-open one. With this, the app
			// can watchdog the connection and reconnect when pings stop.
			if !write(fmt.Sprintf("event: ping\ndata: {\"ts\":%d}\n\n", time.Now().Unix())) {
				return
			}
		case ev, open := <-ch:
			if !open {
				return
			}
			payload, err := json.Marshal(ev.Data)
			if err != nil {
				continue
			}
			if !write(fmt.Sprintf("event: %s\ndata: %s\n\n", ev.Type, payload)) {
				return
			}
		}
	}
}
