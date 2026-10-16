package service

import (
	"context"
	"os"
	"strconv"
	"strings"
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
		if r.Header.Get("X-Agent-Version") != strconv.Itoa(Version) {
			t.Errorf("preguntó sin decir su versión: %q", r.Header.Get("X-Agent-Version"))
		}
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

// La versión que dice el agente es la del fichero que publica el workflow.
func TestTheVersionIsTheFile(t *testing.T) {
	raw, err := os.ReadFile("../../../VERSION")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != strconv.Itoa(Version) {
		t.Errorf("VERSION dice %q y el agente dice %d", strings.TrimSpace(string(raw)), Version)
	}
}

// Mientras hace un trabajo no pregunta por otro, así que late por su ruta,
// con su token; y al acabar deja de latir.
// Mutantes: no latir durante el trabajo; latir por `GET /jobs` (reclamaría
// el siguiente deploy de la cola); seguir latiendo al acabar.
func TestThePollerBeatsWhileItWorks(t *testing.T) {
	var beats, polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/agent/v1/heartbeat":
			if r.Header.Get("Authorization") != "Bearer cac_agent_x" {
				t.Errorf("latió sin su token")
			}
			beats.Add(1)
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/agent/v1/jobs":
			if polls.Add(1) == 1 {
				w.Write([]byte(`{"id":"j-1","kind":"deploy","data":{}}`))
				return
			}
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()

	p := NewPoller(srv.URL, "cac_agent_x")
	p.Wait = 0
	p.BeatEvery = 10 * time.Millisecond
	var during int32
	var pollsDuring int32
	p.OnJob = func(context.Context, Job) {
		time.Sleep(120 * time.Millisecond)
		during = beats.Load()
		pollsDuring = polls.Load()
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.runJob(ctx, Job{ID: "j-1"})
	if during < 3 {
		t.Errorf("latió %d veces en un trabajo de 120 ms con un latido cada 10", during)
	}
	if pollsDuring != 0 {
		t.Errorf("preguntó por trabajo %d veces mientras trabajaba", pollsDuring)
	}
	after := beats.Load()
	time.Sleep(60 * time.Millisecond)
	cancel()
	if n := beats.Load() - after; n > 0 {
		t.Errorf("siguió latiendo %d veces después de acabar", n)
	}
}
