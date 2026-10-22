package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// cac#203. Rotura que detecta: que una clave mal formada o tomada salga como
// un 500, sin decirle a la app qué pasó.
func TestASpaceKeyErrorSaysWhatHappened(t *testing.T) {
	for err, want := range map[error]int{
		repository.ErrSpaceKeyInvalid: http.StatusBadRequest,
		repository.ErrSpaceKeyTaken:   http.StatusConflict,
	} {
		rec := httptest.NewRecorder()
		if !mapTaskError(rec, fmt.Errorf("cambiando: %w", err)) {
			t.Errorf("%v no se reconoce", err)
			continue
		}
		if rec.Code != want || !strings.Contains(rec.Body.String(), err.Error()) {
			t.Errorf("%v: %d %s", err, rec.Code, rec.Body.String())
		}
	}
}
