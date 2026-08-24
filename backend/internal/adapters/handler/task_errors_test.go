package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Qué código HTTP recibe cada negativa.
//
// `mapTaskError` no tenía ninguna prueba, y dos de sus casos ni siquiera
// estaban: mover una tarjeta a una columna prohibida contestaba **500**, que
// dice «se rompió el servidor» cuando lo cierto es «esa regla no lo permite».
// La diferencia importa fuera de la estética: un cliente que reintenta ante 5xx
// —el nuestro— reintenta tres veces contra una regla que nunca va a ceder.
//
// Sin base de datos ni pila de servicios a propósito: lo que se comprueba es
// una tabla de correspondencias, y montar un servidor para leerla sólo añadiría
// formas de que la prueba falle por motivos que no son el suyo.
func TestCadaNegativaTieneSuCodigo(t *testing.T) {
	casos := []struct {
		err    error
		quiero int
		porque string
	}{
		// El fallo reportado: la máquina de estados rechaza el salto.
		{service.ErrBadTransition, http.StatusConflict, "el estado actual no admite ese movimiento"},
		// Distinto: aquí el id de columna no nombra nada, así que es entrada mal
		// formada y no un conflicto con ningún estado.
		{service.ErrBadStatus, http.StatusBadRequest, "el id de columna no existe"},
		// Éstas dos ya contestaban 409, pero desde su propio `if` suelto.
		{service.ErrFolderCycle, http.StatusConflict, "una carpeta dentro de sí misma"},
		{service.ErrDifferentOrganization, http.StatusConflict, "el espacio es de otra organización"},
		// Y las que ya estaban, para que la tabla se lea entera de un vistazo.
		{repository.ErrTaskNotFound, http.StatusNotFound, "no existe"},
		{repository.ErrListNotFound, http.StatusNotFound, "no existe"},
		{repository.ErrChannelOtherOrg, http.StatusForbidden, "no es tuyo"},
		{repository.ErrLastStatus, http.StatusConflict, "una lista necesita una columna"},
		{service.ErrNoStatuses, http.StatusConflict, "la lista no tiene columnas"},
		{service.ErrParentOther, http.StatusBadRequest, "el padre es de otra lista"},
		{service.ErrColumnsAreFixed, http.StatusGone, "las columnas ya no se tocan"},
	}

	for _, c := range casos {
		rec := httptest.NewRecorder()
		if !mapTaskError(rec, c.err) {
			t.Errorf("%v cayó al default y saldrá como 500 — %s", c.err, c.porque)
			continue
		}
		if rec.Code != c.quiero {
			t.Errorf("%v → %d, se esperaba %d (%s)", c.err, rec.Code, c.quiero, c.porque)
		}
	}
}

// Lo que **no** conoce tiene que seguir cayendo al 500.
//
// Un fallo de verdad —la base de datos caída, un puntero nulo— no puede
// disfrazarse de negativa educada: quien vigila la tasa de 5xx tiene que
// seguir viéndolo.
func TestLoQueNoConoceSigueSiendoUnFalloDelServidor(t *testing.T) {
	rec := httptest.NewRecorder()
	if mapTaskError(rec, errors.New("la base de datos se cayó")) {
		t.Error("un error desconocido no puede mapearse a nada; le toca el 500")
	}
}

// Envuelto también, que es como llega desde las capas de abajo.
func TestReconoceElErrorAunqueVengaEnvuelto(t *testing.T) {
	rec := httptest.NewRecorder()
	envuelto := errors.New("al mover la tarjeta: " + service.ErrBadTransition.Error())
	if mapTaskError(rec, envuelto) {
		t.Fatal("comparar por texto sería frágil: sólo `errors.Is` cuenta")
	}

	rec = httptest.NewRecorder()
	if !mapTaskError(rec, fmtWrap(service.ErrBadTransition)) || rec.Code != http.StatusConflict {
		t.Errorf("un %%w envuelto tiene que reconocerse igual, dio %d", rec.Code)
	}
}

func fmtWrap(err error) error { return errWrapper{err} }

type errWrapper struct{ err error }

func (e errWrapper) Error() string { return "al mover la tarjeta: " + e.err.Error() }
func (e errWrapper) Unwrap() error { return e.err }
