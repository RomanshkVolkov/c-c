package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Qué contesta cada negativa al configurar un canal.
//
// Las dos de la bandeja son nuevas: hasta ahora la lista donde caen los
// reportes sólo la escribía una migración de arranque, así que moverla pedía
// SQL. Ahora se puede, y por eso hay dos formas nuevas de equivocarse — y
// ninguna es un fallo del servidor.
func TestLasNegativasDelCanalTienenSuCodigo(t *testing.T) {
	casos := []struct {
		err    error
		quiero int
		porque string
	}{
		// Dejar un canal sin lista no es desconfigurarlo: es que todo lo que le
		// manden a partir de entonces se pierda sin decir nada.
		{repository.ErrChannelNeedsInbox, http.StatusConflict, "un canal sin bandeja pierde lo que reciba"},
		// Y entregar en otra organización sería enseñarle el trabajo de un
		// cliente a gente que no tiene nada que ver con él.
		{service.ErrInboxOtherOrg, http.StatusConflict, "esa lista es de otra organización"},
		// Las que ya estaban, para que la tabla se lea entera.
		{repository.ErrReportProjectNotFound, http.StatusNotFound, "no existe"},
		{repository.ErrReportProjectSlugTaken, http.StatusConflict, "el slug ya está en uso"},
		{service.ErrAssigneeNotMember, http.StatusBadRequest, "el responsable no es de la organización"},
	}

	for _, c := range casos {
		rec := httptest.NewRecorder()
		if !mapReportProjectError(rec, c.err) {
			t.Errorf("%v cayó al default y saldrá como 500 — %s", c.err, c.porque)
			continue
		}
		if rec.Code != c.quiero {
			t.Errorf("%v → %d, se esperaba %d (%s)", c.err, rec.Code, c.quiero, c.porque)
		}
	}
}

// Y lo que no conoce sigue siendo un fallo del servidor: quien vigila la tasa
// de 5xx tiene que seguir viéndolo.
func TestUnFalloDeVerdadSigueSiendo500(t *testing.T) {
	rec := httptest.NewRecorder()
	if mapReportProjectError(rec, errors.New("la base de datos se cayó")) {
		t.Error("un error desconocido no puede mapearse a nada")
	}
}
