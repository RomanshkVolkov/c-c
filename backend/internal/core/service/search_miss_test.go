package service

import "testing"

// Rotura que detecta: guardar como fallida una consulta que ni se buscó
// (vacía, de una letra o sólo signos). Con el repositorio a nil, si llegara a
// él, la prueba revienta.
func TestATooShortQueryIsNotAMiss(t *testing.T) {
	s := &SearchService{}
	for _, q := range []string{"", " ", "a", "!=", "  ¿?  "} {
		if err := s.RecordMiss("u", "o", q); err != nil {
			t.Fatalf("%q: %v", q, err)
		}
	}
}
