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
// Una referencia va entera y sin prefijo; lo que no lo es se parte por el
// guion como siempre (22-oct-2026). Roturas que detecta: partirla (no casa
// con la tarea y sí con «Proteus … 125 vistas»); ponerle prefijo
// (`proteus-125` encontraría `proteus-1250`); tomar por referencia algo que
// no termina en número (`pocna-jobs`) o que empieza por número.
func TestARefIsSearchedWhole(t *testing.T) {
	for q, want := range map[string]string{
		"PROTEUS-125":                 "proteus-125",
		"¿está la tarea proteus-125?": "está:* & la & tarea:* & proteus-125",
		"command-and-control-221":     "command-and-control-221",
		"tds-69 y nada más":           "tds-69 & y & nada:* & más:*",
		"pocna-jobs":                  "pocna:* & jobs:*",
		"2026-10-22":                  "2026:* & 10 & 22:*",
		"-125":                        "125:*",
	} {
		if got := SearchTSQuery(q); got != want {
			t.Errorf("SearchTSQuery(%q) = %q, want %q", q, got, want)
		}
	}
	if sec := SearchSection("# Uno\n\nnada\n\n## Entrega\n\nJira [PROTEUS-125](x)\n", "PROTEUS-125"); sec != "Entrega" {
		t.Errorf("la sección de una referencia: %q", sec)
	}
}

func TestSearchQueryPrefixesEveryTerm(t *testing.T) {
	if got := SearchTSQuery("Pocna jobs"); got != "pocna:* & jobs:*" {
		t.Fatalf("SearchTSQuery = %q", got)
	}
	if got := SearchTSQuery("configuración"); got != "configuración:*" {
		t.Fatalf("una palabra con tilde se rompe: %q", got)
	}
}

// Una palabra de una o dos letras cuenta sólo entera, salvo la última, que en
// la paleta se está escribiendo. Roturas que detecta: volver al prefijo para
// todas («de» encuentra «después»); quitárselo también a la última («puerta d»
// deja de encontrar); contar bytes y no letras («él» tiene dos letras y
// cuatro bytes, y quedaría por prefijo).
func TestAShortWordOnlyMatchesWhole(t *testing.T) {
	for q, want := range map[string]string{
		"puerta de verificación": "puerta:* & de & verificación:*",
		"puerta d":               "puerta:* & d:*",
		"ci":                     "ci:*",
		"él dijo":                "él & dijo:*",
		"ñu ok ya":               "ñu & ok & ya:*",
	} {
		if got := SearchTSQuery(q); got != want {
			t.Errorf("SearchTSQuery(%q) = %q, quería %q", q, got, want)
		}
	}
}

// Roturas que detecta: dejar la negrita del documento (los `**` se cruzan con
// la marca), no poner la marca, o comerse los `_` de un identificador.
func TestASnippetOnlyBoldsWhatWasFound(t *testing.T) {
	in := "| **Cancelados** (Q2) | **407 ⟦de⟧ 412** | la flota ⟦de⟧ agentes, `pocna_jobs` y `__init__`"
	want := "| Cancelados (Q2) | 407 **de** 412 | la flota **de** agentes, `pocna_jobs` y `__init__`"
	if got := CleanSnippet(in); got != want {
		t.Fatalf("CleanSnippet:\n got %q\nwant %q", got, want)
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
	if got != "a & b & c:*" {
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
