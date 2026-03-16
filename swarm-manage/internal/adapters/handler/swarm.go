package handler

import (
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

func (h *SwarmHandler) ListNodes(w http.ResponseWriter, r *http.Request) {
	nodes, err := h.svc.ListNodes(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, nodes)
}
