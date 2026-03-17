package handler

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/swarm-manage/internal/core/service"
)

type SwarmHandler struct {
	svc *service.SwarmService
}

func NewSwarmHandler(svc *service.SwarmService) *SwarmHandler {
	return &SwarmHandler{svc: svc}
}

func (h *SwarmHandler) ListStacks(w http.ResponseWriter, r *http.Request) {
	stacks, err := h.svc.ListStacks(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, stacks)
}

func (h *SwarmHandler) ListServices(w http.ResponseWriter, r *http.Request) {
	stack := chi.URLParam(r, "stack") // empty string = all
	services, err := h.svc.ListServices(r.Context(), stack)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, services)
}

func (h *SwarmHandler) StreamServiceLogs(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	if err := h.svc.StreamServiceLogs(r.Context(), id, w, flusher.Flush); err != nil {
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
		flusher.Flush()
	}
}

func (h *SwarmHandler) ForceUpdateService(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.ForceUpdateService(r.Context(), id); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]string{"message": "service update triggered"})
}

func (h *SwarmHandler) ListNodes(w http.ResponseWriter, r *http.Request) {
	nodes, err := h.svc.ListNodes(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, nodes)
}
