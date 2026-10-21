package domain

import "testing"

// Roturas que detecta: no aceptar un estado a secas (el agente vuelve a pedir
// el tablero entero), ponerle la lista que no es, no pasarlo por Canonical
// (`open` y `done` son los nombres que usa el MCP), o reescribir un id que ya
// trae lista (el handler tiene que verlo tal cual para rechazar una columna
// de otra lista).
func TestABareStateMovesWithinTheTasksOwnList(t *testing.T) {
	cases := map[string]string{
		"in_progress":      "L1/in_progress",
		"open":             "L1/pending",
		"done":             "L1/resolved",
		"resolved":         "L1/resolved",
		"L1/pending":       "L1/pending",
		"OTRA/in_progress": "OTRA/in_progress",
	}
	for in, want := range cases {
		if got := MoveStatusID("L1", in); got != want {
			t.Errorf("MoveStatusID(L1, %q) = %q, quería %q", in, got, want)
		}
	}
	if got := MoveStatusID("L1", string(ReportInProgress)); got != SyntheticStatusID("L1", ReportInProgress) {
		t.Errorf("got %q", got)
	}
}
