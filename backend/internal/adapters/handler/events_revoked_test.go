package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Un stream no vuelve a mirar su credencial: si alguien tenía la sesión de
// otro, cambiar la contraseña no lo echaba, seguía oyendo. Ahora el aviso de
// sesiones cerradas cuelga cada stream de esa persona, y sólo de ella.
// Mutantes: no colgar; colgar con el aviso de cualquiera.
func TestClosingTheSessionsHangsUpTheirStreams(t *testing.T) {
	hub := events.NewHub()
	h := NewEventsHandler(hub, nil)
	pase, _, err := repository.SignURLTicket(&domain.ClaimsJWT{UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}}},
		repository.URLScopeEvents, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec := httptest.NewRecorder()
	hecho := make(chan struct{})
	go func() {
		h.Stream(rec, httptest.NewRequest(http.MethodGet, "/api/v1/events?token="+pase, nil).WithContext(ctx))
		close(hecho)
	}()
	time.Sleep(50 * time.Millisecond)

	hub.Publish(events.Event{Type: service.SessionRevokedEvent, UserID: "u-bea"})
	select {
	case <-hecho:
		t.Fatal("colgó el stream de ana por las sesiones de otra persona")
	case <-time.After(150 * time.Millisecond):
	}

	hub.Publish(events.Event{Type: service.SessionRevokedEvent, UserID: "u-ana"})
	select {
	case <-hecho:
	case <-time.After(2 * time.Second):
		t.Fatal("cerrar sus sesiones no colgó su stream")
	}
	if !strings.Contains(rec.Body.String(), "event: session:revoked") {
		t.Errorf("colgó sin decir por qué: %q", rec.Body.String())
	}
}
