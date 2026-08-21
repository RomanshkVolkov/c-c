package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
Tener la app abierta cuenta como estar por aquí.

Esta ruta **no pasa por el AuthMiddleware** —autentica por `?token=` porque
EventSource no manda cabeceras—, así que el registro de presencia que hace el
middleware en todo lo demás nunca la ve. Y nada en la app consulta la API por
temporizador.

Sin esto, alguien leyendo un canal sin escribir se apagaba a los pocos minutos y
el punto verde decía «ausente» de quien estaba mirando la pantalla. Un indicador
que miente es un indicador que se aprende a ignorar.
*/
func TestElLatidoDelStreamRegistraPresencia(t *testing.T) {
	original := latido
	latido = 5 * time.Millisecond
	defer func() { latido = original }()

	var mu sync.Mutex
	var vistos []string
	h := NewEventsHandler(events.NewHub(), func(userID string) {
		mu.Lock()
		defer mu.Unlock()
		vistos = append(vistos, userID)
	})

	par, err := repository.GenerateTokens("u-ana", "ana", false,
		[]domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events?token="+par.AccessToken, nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	hecho := make(chan struct{})
	go func() {
		h.Stream(rec, req)
		close(hecho)
	}()

	// Tiempo para unos cuantos latidos, y se corta como lo haría cerrar la app.
	time.Sleep(60 * time.Millisecond)
	cancel()
	select {
	case <-hecho:
	case <-time.After(2 * time.Second):
		t.Fatal("el stream no terminó al cancelarse la petición")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(vistos) == 0 {
		t.Fatal("el latido tiene que registrar presencia; no registró ninguna")
	}
	for _, uid := range vistos {
		if uid != "u-ana" {
			t.Errorf("registró a otra persona: %q", uid)
		}
	}
}
