package domain

import (
	_ "embed"
	"encoding/json"
	"testing"
)

//go:embed testdata/headings.json
var headingsFixture []byte

// Los títulos que cuenta el backend son los que cuenta el MCP: la prueba
// gemela es `the_backend_and_the_mcp_count_the_same_headings` en `mcp.rs`, con
// el mismo fichero.
func TestSplitSectionsCountsTheHeadingsTheMCPCounts(t *testing.T) {
	var fx struct {
		Cases []struct {
			Name     string  `json:"name"`
			Body     string  `json:"body"`
			Headings [][]any `json:"headings"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(headingsFixture, &fx); err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Cases {
		got := SplitSections(c.Body)
		if len(got) != len(c.Headings) {
			t.Errorf("%s: %d títulos, se esperaban %d: %+v", c.Name, len(got), len(c.Headings), got)
			continue
		}
		for i, h := range c.Headings {
			if got[i].Heading != h[0].(string) || got[i].Level != int(h[1].(float64)) || got[i].Index != i {
				t.Errorf("%s: el %d es %q/%d, se esperaba %v", c.Name, i, got[i].Heading, got[i].Level, h)
			}
		}
	}
}

func TestASectionEndsAtItsLevelAndOwnsOnlyItsText(t *testing.T) {
	body := "# A\nuno\n## B\ndos  tres\n\n### C\ncuatro\n## D\ncinco"
	s := SplitSections(body)
	if len(s) != 4 {
		t.Fatalf("%+v", s)
	}
	// A llega al final; B hasta D (C es suya); C hasta D.
	if s[0].EndLine != 9 || s[1].StartLine != 2 || s[1].EndLine != 7 || s[2].EndLine != 7 {
		t.Errorf("rangos: %+v", s)
	}
	if s[1].OwnText != "dos tres" {
		t.Errorf("el texto propio de B incluye a su hija o no se limpia: %q", s[1].OwnText)
	}
	if s[0].OwnText != "uno" || s[3].OwnText != "cinco" {
		t.Errorf("%q %q", s[0].OwnText, s[3].OwnText)
	}
}

func TestSectionKeyIgnoresCaseAccentsAndMarks(t *testing.T) {
	if SectionKey("**Volver Atrás**") != SectionKey("volver atras") {
		t.Error("las marcas, las mayúsculas o los acentos cambian la clave")
	}
	if SectionKey("Desplegar") == SectionKey("Desplegar todo") {
		t.Error("dos títulos distintos tienen la misma clave")
	}
}

// rows: las filas que dejaría guardadas un cuerpo, con ids s0, s1…
func rowsOf(body string) []SectionRow {
	var out []SectionRow
	for _, p := range SplitSections(body) {
		out = append(out, SectionRow{ID: "s" + string(rune('0'+p.Index)), Heading: p.Heading,
			Level: p.Level, Ordinal: p.Index, OwnText: p.OwnText})
	}
	return out
}

// ids: qué fila acabó en cada sección nueva ("" = nueva).
func ids(plan SectionPlan, n int) []string {
	out := make([]string, n)
	for _, m := range plan.Matches {
		out[m.Parsed] = m.RowID
	}
	return out
}

func sameIDs(t *testing.T, what string, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %v, se esperaba %v", what, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: %v, se esperaba %v", what, got, want)
		}
	}
}

const deployRunbook = "## Desplegar\n\nEl push a main construye la imagen y la despliega en k8s con el workflow backend\n\n" +
	"## Volver atrás\n\nkubectl rollout undo del deployment cac-backend en el namespace production\n\n" +
	"## Notas\n\nnada\n"

func TestRenamingASectionKeepsItsID(t *testing.T) {
	rows := rowsOf(deployRunbook)

	// Renombre puro: el mismo texto debajo.
	puro := "## Desplegar\n\nEl push a main construye la imagen y la despliega en k8s con el workflow backend\n\n" +
		"## Deshacer un despliegue\n\nkubectl rollout undo del deployment cac-backend en el namespace production\n\n## Notas\n\nnada\n"
	p := ReconcileSections(rows, SplitSections(puro), nil)
	sameIDs(t, "renombre puro", ids(p, 3), "s0", "s1", "s2")
	if len(p.New) != 0 || len(p.Removed) != 0 {
		t.Errorf("un renombre crea o borra: %+v", p)
	}

}

// El umbral, por los dos lados: 8 palabras de 12 se parecen (0,67); 7 de 12
// no (0,58).
func TestARetouchedRenameNeedsSixTenthsOfTheWords(t *testing.T) {
	rows := rowsOf("## Viejo\n\nuno dos tres cuatro cinco seis siete ocho nueve diez\n")
	cerca := "## Nuevo\n\nuno dos tres cuatro cinco seis siete ocho once doce\n"
	sameIDs(t, "retocada", ids(ReconcileSections(rows, SplitSections(cerca), nil), 1), "s0")
	lejos := "## Nuevo\n\nuno dos tres cuatro cinco seis siete once doce trece\n"
	sameIDs(t, "otra", ids(ReconcileSections(rows, SplitSections(lejos), nil), 1), "")
}

// A igualdad de parecido, la viva antes que la borrada, y la más cercana.
func TestSimilarityTiesGoToTheLiveAndTheNearest(t *testing.T) {
	rows := []SectionRow{
		{ID: "borrada", Heading: "X", Level: 2, Ordinal: 0, OwnText: "uno dos", Removed: true},
		{ID: "viva", Heading: "Y", Level: 2, Ordinal: 3, OwnText: "uno dos"},
	}
	sameIDs(t, "viva", ids(ReconcileSections(rows, SplitSections("## Z\nuno dos\n"), nil), 1), "viva")

	rows = []SectionRow{
		{ID: "lejos", Heading: "A", Level: 2, Ordinal: 0, OwnText: "uno dos"},
		{ID: "cerca", Heading: "B", Level: 2, Ordinal: 2, OwnText: "uno dos"},
	}
	body := "## C\nz\n## D\nw\n## E\nuno dos\n"
	sameIDs(t, "cercana", ids(ReconcileSections(rows, SplitSections(body), nil), 3), "", "", "cerca")
}

func TestARewrittenSectionUnderANewTitleIsANewSection(t *testing.T) {
	rows := rowsOf(deployRunbook)
	otra := "## Desplegar\n\nEl push a main construye la imagen y la despliega en k8s con el workflow backend\n\n" +
		"## Costes\n\nla factura de contabo sube en enero\n\n## Notas\n\nnada\n"
	p := ReconcileSections(rows, SplitSections(otra), nil)
	sameIDs(t, "texto nuevo", ids(p, 3), "s0", "", "s2")
	if len(p.New) != 1 || p.New[0] != 1 {
		t.Errorf("nuevas: %v", p.New)
	}
	sameIDs(t, "borradas", p.Removed, "s1")
}

func TestMovingSectionsKeepsTheirIDs(t *testing.T) {
	rows := rowsOf(deployRunbook)
	movido := "## Notas\n\nnada\n\n## Volver atrás\n\nkubectl rollout undo\n\n## Desplegar\n\nEl push\n"
	sameIDs(t, "movidas", ids(ReconcileSections(rows, SplitSections(movido), nil), 3), "s2", "s1", "s0")
}

func TestALevelChangeIsTheSameSection(t *testing.T) {
	rows := rowsOf("## A\nx\n## B\ny\n")
	sameIDs(t, "nivel", ids(ReconcileSections(rows, SplitSections("## A\nx\n### B\ny\n"), nil), 2), "s0", "s1")
}

func TestRepeatedTitlesPairInOrderAndByLevel(t *testing.T) {
	rows := rowsOf("## Notas\na\n## Notas\nb\n")
	// Una tercera «Notas» al final: las dos de antes siguen en orden, sin
	// cruzarse, y la que sobra es nueva.
	p := ReconcileSections(rows, SplitSections("## Notas\na\n## Notas\nb\n## Notas\nc\n"), nil)
	sameIDs(t, "repetidas", ids(p, 3), "s0", "s1", "")

	// Con el mismo título en dos niveles, gana el del mismo nivel.
	rows = rowsOf("## Notas\na\n### Notas\nb\n")
	sameIDs(t, "por nivel", ids(ReconcileSections(rows, SplitSections("### Notas\nb\n## Notas\na\n"), nil), 2), "s1", "s0")
}

func TestARemovedSectionIsMarkedAndRevivesWhenItComesBack(t *testing.T) {
	rows := rowsOf(deployRunbook)
	sin := "## Desplegar\n\nEl push a main construye la imagen y la despliega en k8s con el workflow backend\n\n## Notas\n\nnada\n"
	p := ReconcileSections(rows, SplitSections(sin), nil)
	sameIDs(t, "borrada", p.Removed, "s1")

	// Restaurar la versión vieja revive el mismo id, no crea otro.
	rows[1].Removed = true
	p = ReconcileSections(rows, SplitSections(deployRunbook), nil)
	sameIDs(t, "revivida", ids(p, 3), "s0", "s1", "s2")
	if len(p.New) != 0 || len(p.Removed) != 0 {
		t.Errorf("%+v", p)
	}

	// Una viva gana a una borrada con el mismo título.
	rows = append(rowsOf("## Notas\na\n"), SectionRow{ID: "vieja", Heading: "Notas", Level: 2, Removed: true})
	sameIDs(t, "viva antes", ids(ReconcileSections(rows, SplitSections("## Notas\nz\n"), nil), 1), "s0")
	// Y una borrada no se vuelve a borrar.
	if p := ReconcileSections(rows, SplitSections(""), nil); len(p.Removed) != 1 || p.Removed[0] != "s0" {
		t.Errorf("%+v", p)
	}
}

func TestSplittingASectionKeepsTheIDWithTheMostSimilarHalf(t *testing.T) {
	rows := rowsOf("## Despliegue\n\nuno dos tres cuatro cinco seis siete ocho nueve\n")
	partida := "## En k8s\n\nuno dos tres cuatro cinco seis siete\n\n## En swarm\n\nocho nueve\n"
	sameIDs(t, "partida", ids(ReconcileSections(rows, SplitSections(partida), nil), 2), "s0", "")
}

func TestADeclaredRenameWinsOverGuessing(t *testing.T) {
	rows := rowsOf("## A\nx\n## B\ny\n")
	// Sin pista, «C» con otro texto sería nueva y B se borraría.
	body := "## A\nx\n## C\notra cosa\n"
	sameIDs(t, "sin pista", ids(ReconcileSections(rows, SplitSections(body), nil), 2), "s0", "")
	sameIDs(t, "con pista", ids(ReconcileSections(rows, SplitSections(body), map[string]string{"s1": "c"}), 2), "s0", "s1")
	// Si el título nuevo sale dos veces, la pista se queda con la más cercana.
	dos := "## A\nx\n## C\nq\n## Otra\n## Más\n## C\nr\n"
	sameIDs(t, "pista doble", ids(ReconcileSections(rows, SplitSections(dos), map[string]string{"s1": "C"}), 5),
		"s0", "s1", "", "", "")
	// Una pista a un título que no está no empareja nada.
	sameIDs(t, "pista rota", ids(ReconcileSections(rows, SplitSections(body), map[string]string{"s1": "D"}), 2), "s0", "")
}

func TestEmptyTextsAndTitlesDoNotMatchByText(t *testing.T) {
	rows := rowsOf("## A\n## B\n")
	// Dos secciones vacías con otro título no son renombres de las viejas.
	p := ReconcileSections(rows, SplitSections("## C\n## D\n"), nil)
	sameIDs(t, "vacías", ids(p, 2), "", "")
	if len(p.Removed) != 2 {
		t.Errorf("%+v", p)
	}
	if jaccard("", "") != 0 || jaccard("a b", "a b") != 1 {
		t.Error("jaccard")
	}
}
