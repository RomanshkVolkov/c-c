package domain

import "testing"

// Roturas que detecta: que la raíz sustituya a la palabra en vez de sumarse
// (se perdería lo que casa por la palabra entera), que una raíz corta o con
// signos entre en la consulta (ruido, o un `to_tsquery` que revienta), que
// una referencia o una palabra corta se lematice, y que «con alguna» junte
// con & (command-and-control-294).
func TestAStemWidensAWordAndNeverReplacesIt(t *testing.T) {
	stems := map[string]string{"publicación": "public", "riesgos": "riesg", "casas": "cas", "servidor": "serv:dor"}
	cases := []struct {
		q       string
		anyWord bool
		want    string
	}{
		{"riesgos publicación", false, "(riesgos:* | riesg:*) & (publicación:* | public:*)"},
		{"riesgos publicación", true, "(riesgos:* | riesg:*) | (publicación:* | public:*)"},
		{"casas", false, "casas:*"},       // raíz de tres letras: fuera
		{"servidor", false, "servidor:*"}, // raíz con signos: fuera
		{"proteus-221 riesgos", false, "proteus-221 & (riesgos:* | riesg:*)"},
	}
	for _, c := range cases {
		if got := SearchTSQueryWith(c.q, stems, c.anyWord); got != c.want {
			t.Errorf("%q any=%v: %q, quería %q", c.q, c.anyWord, got, c.want)
		}
	}
	if got := SearchTSQuery("riesgos publicación"); got != "riesgos:* & publicación:*" {
		t.Errorf("sin raíces cambió la consulta de siempre: %q", got)
	}
}

func TestOnlyLongPlainWordsAreStemmed(t *testing.T) {
	got := SearchStemWords("de riesgos proteus-221 la publicación casa")
	want := []string{"riesgos", "publicación"}
	if len(got) != len(want) {
		t.Fatalf("%v, quería %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v, quería %v", got, want)
		}
	}
}

func TestAPastedIDIsRecognised(t *testing.T) {
	if id, ok := SearchID("  1B0ADD6D-6ff5-40c2-ae60-8477fbb434ce "); !ok || id != "1b0add6d-6ff5-40c2-ae60-8477fbb434ce" {
		t.Errorf("un uuid pegado no se reconoce: %q %v", id, ok)
	}
	for _, q := range []string{
		"1b0add6d-6ff5-40c2-ae60-8477fbb434c",  // corto
		"1b0add6d-6ff5-40c2-ae60-8477fbb434cg", // no hex
		"1b0add6d06ff5-40c2-ae60-8477fbb434ce", // guion en su sitio
		"proteus-221", "riesgos de publicación",
	} {
		if _, ok := SearchID(q); ok {
			t.Errorf("%q se tomó por un id", q)
		}
	}
}

// Roturas que atrapa: recortar por bytes (parte una letra con tilde) o no
// recortar.
func TestSubtaskWhereTrimsTheParentTitleByLetters(t *testing.T) {
	long := "Lo que mordió se registra por servidor y por área"
	if got := SubtaskWhere("Backend", 289, long); got != "Backend › #289 Lo que mordió se registra por servidor y…" {
		t.Errorf("%q", got)
	}
	if got := SubtaskWhere("Backend", 7, "Corto"); got != "Backend › #7 Corto" {
		t.Errorf("%q", got)
	}
	ñ := "ñññññññññññññññññññññññññññññññññññññññññ"
	if got := SubtaskWhere("L", 1, ñ); got != "L › #1 "+string([]rune(ñ)[:40])+"…" {
		t.Errorf("recorta mal una ñ: %q", got)
	}
}
