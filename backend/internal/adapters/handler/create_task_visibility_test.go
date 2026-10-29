package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Lo que crea un agente nace interno; lo que crea una persona, como siempre.
// Y el agente publica cuando se lo piden. Roturas que detecta: no mirar si es
// un token (todo interno, también lo de las personas), no aplicarlo (un agente
// vuelve a publicar sin querer), o pisar un `public` pedido a propósito.
func TestAnAgentsTaskIsBornInternal(t *testing.T) {
	pide := func(body string, viaToken bool) domain.ItemVisibility {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/task-lists/l/tasks", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		c := &domain.ClaimsJWT{UserID: "u-1", ViaToken: viaToken}
		r = r.WithContext(context.WithValue(r.Context(), repository.UserContextKey, c))
		req, err := createTaskRequest(r)
		if err != nil {
			t.Fatal(err)
		}
		return req.Visibility
	}
	if v := pide(`{"title":"Migrar a Postgres"}`, true); v != domain.VisibilityInternal {
		t.Errorf("un agente sin decir nada crea %q, no interna", v)
	}
	if v := pide(`{"title":"Lo que pidió el cliente","visibility":"public"}`, true); v != domain.VisibilityPublic {
		t.Errorf("un agente que pide publicarla crea %q", v)
	}
	if v := pide(`{"title":"Desde la app"}`, false); v != "" {
		t.Errorf("una persona en la app ya no crea como antes: %q", v)
	}
}
