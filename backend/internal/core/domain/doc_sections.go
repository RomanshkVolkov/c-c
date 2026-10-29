package domain

import (
	"sort"
	"strings"
	"time"
)

/*
Secciones con identidad (command-and-control-91).

Una decisión tiene que poder apuntar a la sección del runbook que la aplica, y
ese enlace tiene que sobrevivir a que alguien la renombre. El texto no puede
llevar el ancla: el editor guarda markdown sin HTML (`html: false` en
`MarkdownEditor.tsx`) y se comería un comentario escondido la primera vez que
alguien edite desde la app. Así que la identidad vive en el servidor
(`DocSection`), y cada escritura de una pestaña o una página la **reconcilia**
con los títulos nuevos: qué sección de antes es cada una de ahora.

Aquí está la parte pura —partir y emparejar—, para poder probarla sin base.
*/

// ParsedSection: una sección de un markdown, tal como la cuentan `sections`
// del MCP y `AppendToSection`: de su título hasta el siguiente título de su
// nivel o mayor. Las líneas van de 0 y `EndLine` no se incluye.
type ParsedSection struct {
	Heading string
	Level   int
	// Index: el puesto del título entre todos los de la pestaña.
	Index int
	// OwnText: lo que hay bajo el título hasta el siguiente título de
	// **cualquier** nivel, sin espacios de sobra. Es lo que reconoce un
	// renombre aunque cambien sus hijas.
	OwnText   string
	StartLine int
	EndLine   int
}

// SplitSections: las secciones de un markdown, en orden. Un `#` dentro de un
// bloque de código no es un título (`scanMarkdown`).
func SplitSections(body string) []ParsedSection {
	var out []ParsedSection
	var own []string
	closeOwn := func() {
		if n := len(out); n > 0 {
			out[n-1].OwnText = strings.Join(strings.Fields(strings.Join(own, "\n")), " ")
		}
		own = own[:0]
	}
	i := 0
	scanMarkdown(body, func(line, heading string, level int) {
		if level > 0 {
			closeOwn()
			out = append(out, ParsedSection{Heading: heading, Level: level, Index: len(out), StartLine: i})
		} else if len(out) > 0 {
			own = append(own, line)
		}
		i++
	})
	closeOwn()
	for k := range out {
		out[k].EndLine = i
		for _, next := range out[k+1:] {
			if next.Level <= out[k].Level {
				out[k].EndLine = next.StartLine
				break
			}
		}
	}
	return out
}

// SectionKey: cómo se comparan dos títulos. Sin mayúsculas, sin acentos y sin
// las marcas de markdown (`**Correo**` es «Correo»).
func SectionKey(heading string) string {
	return strings.Join(foldWords(heading), " ")
}

// SectionRow: lo que la reconciliación necesita saber de una sección guardada.
type SectionRow struct {
	ID      string
	Heading string
	Level   int
	Ordinal int
	OwnText string
	Removed bool
}

// SectionMatch: la fila `RowID` es ahora la sección `Parsed` (su índice).
type SectionMatch struct {
	RowID  string
	Parsed int
}

// SectionPlan: lo que hay que escribir tras una reconciliación.
type SectionPlan struct {
	// Matches: filas que siguen, revividas o no, con el título, nivel y
	// puesto de su sección nueva.
	Matches []SectionMatch
	// New: secciones sin fila; se crean.
	New []int
	// Removed: filas vivas que ya no están. Se marcan, no se borran: un
	// enlace a ellas tiene que poder decir cómo se llamaban.
	Removed []string
}

// SimilarSectionText: desde cuánto parecido (Jaccard de palabras) una sección
// con otro título se toma por la misma retocada.
const SimilarSectionText = 0.6

// ReconcileSections empareja las filas guardadas con las secciones nuevas.
// Cada fila y cada sección se usa una sola vez, por pasos y en este orden:
//
//  0. `hints` (id → título nuevo): un renombre que alguien declaró, como
//     `write_doc_section` con `renameTo`. No se adivina lo que se sabe.
//  1. El mismo título (`SectionKey`). Las vivas antes que las borradas, así
//     que restaurar una versión revive el id viejo. Con títulos repetidos,
//     en orden, y el mismo nivel antes que otro.
//  2. Un texto propio parecido (≥ `SimilarSectionText`): un renombre, puro
//     (el mismo texto puntúa 1) o con retoque. Gana el más parecido; a
//     igualdad, la viva y la más cercana.
//
// Lo que queda son secciones nuevas y filas que dejan de estar.
func ReconcileSections(rows []SectionRow, parsed []ParsedSection, hints map[string]string) SectionPlan {
	ordered := append([]SectionRow(nil), rows...)
	sort.SliceStable(ordered, func(a, b int) bool {
		if ordered[a].Removed != ordered[b].Removed {
			return !ordered[a].Removed
		}
		return ordered[a].Ordinal < ordered[b].Ordinal
	})
	usedRow := map[string]bool{}
	usedParsed := make([]bool, len(parsed))
	var plan SectionPlan
	match := func(row string, p int) {
		usedRow[row], usedParsed[p] = true, true
		plan.Matches = append(plan.Matches, SectionMatch{RowID: row, Parsed: p})
	}

	// 0 · Lo declarado.
	for _, r := range ordered {
		h, ok := hints[r.ID]
		if !ok || usedRow[r.ID] {
			continue
		}
		best := -1
		for p := range parsed {
			if usedParsed[p] || SectionKey(parsed[p].Heading) != SectionKey(h) {
				continue
			}
			if best < 0 || distance(parsed[p].Index, r.Ordinal) < distance(parsed[best].Index, r.Ordinal) {
				best = p
			}
		}
		if best >= 0 {
			match(r.ID, best)
		}
	}

	// 1 · El mismo título: primero al mismo nivel, luego a cualquiera.
	for _, sameLevel := range []bool{true, false} {
		for p := range parsed {
			if usedParsed[p] {
				continue
			}
			for _, r := range ordered {
				if !usedRow[r.ID] && SectionKey(r.Heading) == SectionKey(parsed[p].Heading) &&
					(!sameLevel || r.Level == parsed[p].Level) {
					match(r.ID, p)
					break
				}
			}
		}
	}

	// 2 · El texto parecido; el mismo texto puntúa 1 y va primero.
	type pair struct {
		row     SectionRow
		p       int
		score   float64
		closest int
	}
	var pairs []pair
	for _, r := range ordered {
		if usedRow[r.ID] {
			continue
		}
		for p := range parsed {
			if usedParsed[p] {
				continue
			}
			if s := jaccard(r.OwnText, parsed[p].OwnText); s >= SimilarSectionText {
				pairs = append(pairs, pair{r, p, s, distance(parsed[p].Index, r.Ordinal)})
			}
		}
	}
	sort.SliceStable(pairs, func(a, b int) bool {
		x, y := pairs[a], pairs[b]
		if x.score != y.score {
			return x.score > y.score
		}
		if x.row.Removed != y.row.Removed {
			return !x.row.Removed
		}
		return x.closest < y.closest
	})
	for _, c := range pairs {
		if !usedRow[c.row.ID] && !usedParsed[c.p] {
			match(c.row.ID, c.p)
		}
	}

	for p := range parsed {
		if !usedParsed[p] {
			plan.New = append(plan.New, p)
		}
	}
	for _, r := range ordered {
		if !usedRow[r.ID] && !r.Removed {
			plan.Removed = append(plan.Removed, r.ID)
		}
	}
	return plan
}

func distance(a, b int) int {
	if a > b {
		return a - b
	}
	return b - a
}

// jaccard: cuánto se parecen dos textos por sus palabras (sin mayúsculas ni
// acentos), de 0 a 1. Dos textos vacíos no se parecen: no dicen nada.
func jaccard(a, b string) float64 {
	wa, wb := wordSet(a), wordSet(b)
	if len(wa) == 0 || len(wb) == 0 {
		return 0
	}
	both := 0
	for w := range wa {
		if wb[w] {
			both++
		}
	}
	return float64(both) / float64(len(wa)+len(wb)-both)
}

func wordSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range foldWords(s) {
		out[w] = true
	}
	return out
}

// DocSection: la identidad de una sección de una pestaña o de una página.
//
// La escribe sólo la reconciliación (`DocRepository.syncSections`), en la
// misma transacción que el cuerpo. Una sección que desaparece no se borra: se
// marca (`RemovedAt`) y conserva su último título, porque un enlace a ella
// tiene que poder decir «se llamaba X»; y si vuelve —restaurar una versión—
// revive con el mismo id.
type DocSection struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);not null;index" json:"-"`
	DocID string `gorm:"type:varchar(36);not null;index:idx_docsection_owner,priority:1" json:"docId"`
	// Tab: la pestaña; vacía si la sección es de una página.
	Tab    DocTabKey `gorm:"type:varchar(20);not null;default:'';index:idx_docsection_owner,priority:2" json:"tab,omitempty"`
	PageID *string   `gorm:"type:varchar(36);index:idx_docsection_owner,priority:3" json:"pageId,omitempty"`
	// Heading: el título tal cual, sin los `#`.
	Heading string `gorm:"type:text;not null;default:''" json:"heading"`
	Level   int    `gorm:"not null;default:0" json:"level"`
	// Ordinal: el puesto del título en su pestaña o página.
	Ordinal int `gorm:"not null;default:0" json:"ordinal"`
	// OwnText: el texto bajo el título (ver `ParsedSection.OwnText`). Sólo
	// para reconocer un renombre.
	OwnText   string     `gorm:"type:text" json:"-"`
	RemovedAt *time.Time `json:"removedAt,omitempty"`
}

// DocSectionView: una sección viva tal como sale con su pestaña o su página.
type DocSectionView struct {
	ID      string `json:"id"`
	Heading string `json:"heading"`
	Level   int    `json:"level"`
	Index   int    `json:"index"`
}
