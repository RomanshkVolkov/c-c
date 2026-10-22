package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Los errores de reclamar y de depender llegan con su código y su número, no
// como un 500 opaco: el agente que se encuentra la tarea en manos de otro
// tiene que saberlo para comentar en vez de pisar (22-oct-2026).
func TestClaimAndBlockerErrorsHaveTheirOwnCodes(t *testing.T) {
	for _, c := range []struct {
		err  error
		code int
		tag  string
	}{
		{service.ErrTaskStatusChanged, http.StatusConflict, "task-status-changed"},
		{service.ErrTaskClaimedByOther, http.StatusConflict, "task-claimed-by-other"},
		{service.ErrBlockerNotFound, http.StatusBadRequest, "blocker-not-found"},
		{service.ErrBlockerIsSelf, http.StatusBadRequest, "blocker-is-self"},
	} {
		rec := httptest.NewRecorder()
		if !mapTaskError(rec, c.err) {
			t.Fatalf("%v no está mapeado", c.err)
		}
		if rec.Code != c.code || !strings.Contains(rec.Body.String(), c.tag) {
			t.Fatalf("%v → %d %s; quería %d %s", c.err, rec.Code, rec.Body.String(), c.code, c.tag)
		}
	}
}
