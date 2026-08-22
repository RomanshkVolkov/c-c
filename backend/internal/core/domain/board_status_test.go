package domain

import "testing"

/*
Cada columna dice qué estado es.

Hace falta porque el cliente tiene que saber a qué columna corresponde cada una
para poder mover una tarjeta, y las dos vías que había no sirven: `Kind` mete
«Done» y «Closed» en el mismo saco, y partir el id por la barra sería duplicar
en el cliente una regla que es del servidor.
*/
func TestCadaColumnaDiceQueEstadoEs(t *testing.T) {
	cols := BoardStatuses("l-1")
	if len(cols) != 4 {
		t.Fatalf("cuatro columnas, y hay %d", len(cols))
	}
	for _, c := range cols {
		if c.Status == "" {
			t.Errorf("la columna %q no dice su estado", c.Name)
		}
		// Y el estado que dice es el mismo que lleva su id, que es lo que hace
		// que el cliente pueda fiarse del campo en vez de parsear.
		if quiere := SyntheticStatusID("l-1", c.Status); c.ID != quiere {
			t.Errorf("la columna %q dice %q pero su id es %q", c.Name, c.Status, c.ID)
		}
	}

	// Las dos terminadas se distinguen por el estado y no por la clase. Este es
	// el caso que motivó el campo.
	var acabadas []ReportStatus
	for _, c := range cols {
		if c.Kind == StatusKindDone {
			acabadas = append(acabadas, c.Status)
		}
	}
	if len(acabadas) != 2 || acabadas[0] == acabadas[1] {
		t.Errorf("«Done» y «Closed» son las dos `done` y tienen que ser distinguibles: %v", acabadas)
	}
}
