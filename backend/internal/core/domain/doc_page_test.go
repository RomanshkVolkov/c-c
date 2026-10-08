package domain

import (
	"strings"
	"testing"
)

// Cada palabra por prefijo, y todas a la vez.
//
// Los mutantes que mata: quitar el `:*` (entonces «pocna» no encuentra
// `pocna-jobs` ni «desplieg» encuentra «despliegues») y unir con `|` (cualquier
// palabra bastaría, y buscar dos daría más resultados que buscar una).
func TestSearchQueryPrefixesEveryTerm(t *testing.T) {
	if got := SearchTSQuery("Pocna jobs"); got != "pocna:* & jobs:*" {
		t.Fatalf("SearchTSQuery = %q", got)
	}
	if got := SearchTSQuery("configuración"); got != "configuración:*" {
		t.Fatalf("una palabra con tilde se rompe: %q", got)
	}
}

// Lo que no es letra ni dígito no llega a Postgres: un operador suelto de
// `to_tsquery` haría que la consulta reventara.
func TestSearchQueryStripsOperators(t *testing.T) {
	got := SearchTSQuery(`a & b | !c:*('"`)
	for _, op := range []string{"|", "!", "(", "'", `"`} {
		if strings.Contains(got, op) {
			t.Fatalf("pasó el operador %q: %q", op, got)
		}
	}
	if got != "a:* & b:* & c:*" {
		t.Fatalf("SearchTSQuery = %q", got)
	}
	if SearchTSQuery(" !& ") != "" {
		t.Fatal("una búsqueda sin palabras tiene que quedar vacía")
	}
}

// Una página no puede colgar de sí misma ni de una hija suya.
//
// El mutante que mata: no recorrer hacia arriba (sólo mirar la madre directa).
func TestAPageCannotMoveUnderItself(t *testing.T) {
	ptr := func(s string) *string { return &s }
	tree := map[string]*string{"a": nil, "b": ptr("a"), "c": ptr("b"), "d": nil}
	if !PageMoveMakesACycle(tree, "a", ptr("c")) {
		t.Fatal("mover una página bajo su nieta se acepta")
	}
	if !PageMoveMakesACycle(tree, "a", ptr("a")) {
		t.Fatal("mover una página bajo sí misma se acepta")
	}
	if PageMoveMakesACycle(tree, "c", ptr("d")) || PageMoveMakesACycle(tree, "b", nil) {
		t.Fatal("un movimiento legal se rechaza")
	}
}

// Un doc con la portada vacía y páginas debajo **está** escrito.
//
// El mutante que mata: olvidar las páginas. El navegador lo pintaría como sin
// documentar.
func TestDocMarkIsWrittenWhenOnlyPagesExist(t *testing.T) {
	if !DocMarkWritten(false, "", 3) {
		t.Fatal("un doc con sólo páginas no cuenta como escrito")
	}
	if DocMarkWritten(false, "", 0) {
		t.Fatal("un doc vacío cuenta como escrito")
	}
}

// El tope va en caracteres, no en bytes.
func TestTheBodyCapCountsCharacters(t *testing.T) {
	if DocBodyTooLong(strings.Repeat("ñ", MaxDocBodyChars)) {
		t.Fatal("un texto con tildes justo en el tope se rechaza por sus bytes")
	}
	if !DocBodyTooLong(strings.Repeat("a", MaxDocBodyChars+1)) {
		t.Fatal("un texto por encima del tope se acepta")
	}
}
