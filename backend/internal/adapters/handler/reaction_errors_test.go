package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Lo que contesta reaccionar mal. La app distingue por el código: un emoji que
// no vale es un 400 con `bad-reaction` (la pantalla no lo ofrece, así que es un
// cliente viejo o un intento), y un mensaje que no es de ese canal o de esa
// conversación es un 404, no un 500 que manda a buscar un fallo del servidor.
// Mutantes: quitar cualquiera de los `case` nuevos.
func TestReaccionarMalContestaLoQueEs(t *testing.T) {
	envolver := func(err error) error { return fmt.Errorf("react: %w", err) }
	for _, c := range []struct {
		nombre string
		mapa   func(http.ResponseWriter, error) bool
		err    error
		status int
		code   string
	}{
		{"canal, emoji", mapChatError, envolver(service.ErrBadReaction), 400, "bad-reaction"},
		{"canal, mensaje ajeno", mapChatError, envolver(repository.ErrMessageNotFound), 404, "not-found"},
		{"directo, emoji", mapDMError, envolver(service.ErrBadReaction), 400, "bad-reaction"},
		{"directo, mensaje ajeno", mapDMError, envolver(repository.ErrDMMessageNotFound), 404, "not-found"},
	} {
		w := httptest.NewRecorder()
		if !c.mapa(w, c.err) {
			t.Errorf("%s: no se trató como error", c.nombre)
			continue
		}
		if w.Code != c.status || !strings.Contains(w.Body.String(), c.code) {
			t.Errorf("%s: %d %s, se esperaba %d %s", c.nombre, w.Code, w.Body.String(), c.status, c.code)
		}
	}
}
