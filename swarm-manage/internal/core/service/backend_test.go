package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// El agente le pregunta al backend con su token, vuelve a preguntar tras un
// 204, entrega los trabajos y, tras un fallo, espera antes de reintentar.
func TestThePollerAsksWithItsTokenAndKeepsAsking(t *testing.T) {
	var preguntas atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cac_agent_x" {
			t.Errorf("preguntó sin su token: %q", r.Header.Get("Authorization"))
		}
		if r.URL.Query().Get("wait") != "0" {
			t.Errorf("wait=%q, se esperaba 0", r.URL.Query().Get("wait"))
		}
		switch preguntas.Add(1) {
		case 1:
			w.WriteHeader(http.StatusNoContent)
		case 2:
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.Write([]byte(`{"id":"j-1","kind":"deploy","data":{}}`))
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	llegó := make(chan Job, 1)
	p := NewPoller(srv.URL, "cac_agent_x")
	p.Wait = 0
	p.MinBackoff, p.MaxBackoff = 10*time.Millisecond, 20*time.Millisecond
	p.OnJob = func(_ context.Context, j Job) {
		select {
		case llegó <- j:
		default:
		}
		cancel()
	}
	go p.Run(ctx)

	select {
	case j := <-llegó:
		if j.ID != "j-1" || j.Kind != "deploy" {
			t.Errorf("llegó otro trabajo: %+v", j)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("no llegó el trabajo; preguntó %d veces", preguntas.Load())
	}
	if n := preguntas.Load(); n < 3 {
		t.Errorf("preguntó %d veces; tras el 204 y el 500 tenía que seguir", n)
	}
}

// Un fallo no se convierte en un bucle que martillea al backend.
func TestThePollerBacksOffAfterAFailure(t *testing.T) {
	var preguntas atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		preguntas.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	p := NewPoller(srv.URL, "cac_agent_x")
	p.Wait = 0
	p.MinBackoff, p.MaxBackoff = 100*time.Millisecond, 100*time.Millisecond
	p.Run(ctx)

	// Con 100 ms de espera, en 350 ms caben cuatro preguntas; sin espera,
	// cientos.
	if n := preguntas.Load(); n > 5 {
		t.Errorf("preguntó %d veces en 350 ms: no espera tras un fallo", n)
	}
}
