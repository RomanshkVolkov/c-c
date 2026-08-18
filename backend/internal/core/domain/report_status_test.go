package domain

import "encoding/json"

import "testing"

// The console is an installed desktop binary that users update by hand, so for
// a while two vocabularies are in flight at once: older builds say "pending"
// and "resolved", newer ones say "open" and "done". These tests pin the rule
// that makes that survivable — both spellings mean the same state everywhere a
// status can enter the system.

func TestBothVocabulariesNameTheSameState(t *testing.T) {
	same := []struct{ old, new ReportStatus }{
		{ReportPending, "open"},
		{ReportResolved, "done"},
	}
	for _, c := range same {
		if c.new.Canonical() != c.old.Canonical() {
			t.Errorf("%q and %q should fold to the same state, got %q vs %q",
				c.new, c.old, c.new.Canonical(), c.old.Canonical())
		}
		if !c.new.IsValid() {
			t.Errorf("%q must be accepted on input", c.new)
		}
	}
}

func TestUnchangedStatesAreSpelledTheSameInBoth(t *testing.T) {
	for _, s := range []ReportStatus{ReportInProgress, ReportClosed} {
		if s.Canonical() != s {
			t.Errorf("%q has no alias and must fold to itself, got %q", s, s.Canonical())
		}
	}
}

// A typo must still be rejected — folding an unknown value silently would turn
// a bad request into a wrong write.
func TestUnknownStatusIsStillRejected(t *testing.T) {
	for _, s := range []ReportStatus{"", "opened", "Done", "in-progress", "pendiente"} {
		if s.IsValid() {
			t.Errorf("%q must not be accepted", s)
		}
	}
}

// Transitions have to answer identically no matter which vocabulary each side
// is written in, including mixed pairs — which is exactly what happens while an
// old client talks to a new server.
func TestTransitionsAgreeAcrossVocabularies(t *testing.T) {
	legal := []struct{ from, to ReportStatus }{
		{"open", ReportInProgress},
		{ReportPending, ReportInProgress},
		{ReportInProgress, "done"},
		{ReportInProgress, ReportResolved},
		{"done", ReportInProgress},
		{"open", ReportClosed},
	}
	for _, c := range legal {
		if !c.from.CanTransitionTo(c.to) {
			t.Errorf("%q → %q should be allowed", c.from, c.to)
		}
	}

	illegal := []struct{ from, to ReportStatus }{
		{ReportClosed, ReportInProgress},
		{ReportClosed, "open"},
		{"open", "done"}, // must pass through in_progress, same as pending → resolved
		{ReportPending, ReportResolved},
	}
	for _, c := range illegal {
		if c.from.CanTransitionTo(c.to) {
			t.Errorf("%q → %q should be refused", c.from, c.to)
		}
	}
}

// Las columnas del tablero se llaman como los estados que son.
//
// El vocabulario se unificó con el de portento —open / in_progress / done /
// closed— pero el tablero siguió llamando «To do» a la primera columna, así
// que el mismo estado se leía de dos maneras según si mirabas un reporte o una
// tarea. Esto lo fija: es sólo un rótulo, y por eso mismo nada avisa cuando se
// separa de lo que nombra.
func TestLasColumnasSeLlamanComoLosEstadosQueSon(t *testing.T) {
	quiero := map[ReportStatus]string{
		ReportPending:    "Open",
		ReportInProgress: "In progress",
		ReportResolved:   "Done",
		ReportClosed:     "Closed",
	}
	for _, c := range boardColumns {
		if quiero[c.Status] != c.Name {
			t.Errorf("el estado %q se llama %q y debería llamarse %q", c.Status, c.Name, quiero[c.Status])
		}
	}
	if len(boardColumns) != len(quiero) {
		t.Errorf("son cuatro estados, hay %d columnas", len(boardColumns))
	}
}

// El estado crudo viaja al cliente.
//
// Sin él, la app sólo tiene la *clase*, que mete `done` y `closed` en el mismo
// saco: un tablero de cuatro columnas se queda con tres y lo cerrado se
// esconde dentro de lo terminado. Y si el campo desapareciera del JSON, el
// cliente agruparía por un valor vacío y el tablero saldría vacío **sin dar
// ningún error**, que es la peor forma de romperse.
func TestElEstadoCrudoViajaEnLaTareaAbierta(t *testing.T) {
	crudo, err := json.Marshal(OpenTask{
		ID: "t-1", Status: ReportClosed, StatusName: "Closed", StatusKind: StatusKindDone,
	})
	if err != nil {
		t.Fatal(err)
	}
	var salio map[string]any
	if err := json.Unmarshal(crudo, &salio); err != nil {
		t.Fatal(err)
	}
	if salio["status"] != string(ReportClosed) {
		t.Errorf("el estado tiene que salir en el JSON, salió %v", salio["status"])
	}
	// Y la clase sigue ahí para quien todavía la lea: esto añade, no sustituye.
	if salio["statusKind"] != string(StatusKindDone) {
		t.Errorf("la clase debe seguir viajando, salió %v", salio["statusKind"])
	}
}
