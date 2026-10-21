package domain

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// SearchSection: el título de la sección de `body` donde cae lo buscado, o ""
// si el documento no tiene títulos o no se encuentra.
//
// Para que un agente lea **esa sección** y no la pestaña entera: con sólo la
// pestaña, tenía que pedir el índice y adivinar en cuál de veinte títulos
// estaba lo que encontró la búsqueda. El título sale tal como lo pide
// `get_doc(tab, section)` del MCP.
//
// Los títulos se reconocen con las mismas reglas que `sections` del MCP
// (`app/src-tauri/src/mcp.rs`): de uno a seis `#` y un espacio, y nunca dentro
// de un bloque de código, donde un `# comentario` no es un título. Si las dos
// difieren, aquí saldría un título que allí no existe.
//
// Cada sección es lo que hay bajo su título **hasta el siguiente título de
// cualquier nivel**, así que gana la más concreta. Gana la que contiene más
// palabras distintas de la consulta; a igualdad, la primera. Las palabras se
// comparan como en la búsqueda: por prefijo, sin mayúsculas y sin acentos
// (`SearchTSQuery`, `cac_simple`).
func SearchSection(body, query string) string {
	terms := foldWords(query)
	if len(terms) == 0 {
		return ""
	}
	best, bestScore := "", 0
	heading, seen := "", map[string]bool{}
	closeSection := func() {
		if heading != "" && len(seen) > bestScore {
			best, bestScore = heading, len(seen)
		}
	}
	scanMarkdown(body, func(line, text string, level int) {
		if level > 0 {
			closeSection()
			heading, seen = text, map[string]bool{}
		}
		for _, w := range foldWords(line) {
			for _, term := range terms {
				if strings.HasPrefix(w, term) {
					seen[term] = true
				}
			}
		}
	})
	closeSection()
	return best
}

// MarkdownHeading: un título de un markdown, como lo cuenta `get_doc` del MCP.
type MarkdownHeading struct {
	Text  string `json:"text"`
	Level int    `json:"level"`
}

// MarkdownHeadings: los títulos de un markdown hasta el nivel `maxLevel`, con
// las reglas de `SearchSection`. Es el índice de una pestaña sin su cuerpo.
func MarkdownHeadings(body string, maxLevel int) []MarkdownHeading {
	out := []MarkdownHeading{}
	scanMarkdown(body, func(_, text string, level int) {
		if level > 0 && level <= maxLevel {
			out = append(out, MarkdownHeading{Text: text, Level: level})
		}
	})
	return out
}

// scanMarkdown recorre un markdown línea a línea y dice en cuáles hay un
// título (`level` > 0) y cuál es su texto. Un `#` dentro de un bloque de
// código no es un título.
func scanMarkdown(body string, each func(line, heading string, level int)) {
	fence := ""
	for line := range strings.SplitSeq(body, "\n") {
		t := strings.TrimLeft(line, " \t")
		marker := ""
		if strings.HasPrefix(t, "```") {
			marker = "```"
		} else if strings.HasPrefix(t, "~~~") {
			marker = "~~~"
		}
		switch {
		case fence == "" && marker != "":
			fence = marker
		case fence != "" && marker == fence:
			fence = ""
		}
		text, level := "", 0
		if fence == "" && marker == "" {
			text, level = markdownHeading(line)
		}
		each(line, text, level)
	}
}

// markdownHeading: el texto y el nivel de un título ATX (`## Correo`), sin los
// `#` de los lados; nivel 0 si no lo es. Como `sections` del MCP: sin espacio
// delante y con uno detrás.
func markdownHeading(line string) (string, int) {
	n := 0
	for n < len(line) && line[n] == '#' {
		n++
	}
	if n < 1 || n > 6 || !strings.HasPrefix(line[n:], " ") {
		return "", 0
	}
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line[n:]), "#")), n
}

// foldWords: las palabras de un texto en minúsculas y sin acentos, partiendo
// por lo que no es letra ni dígito (como `SearchTSQuery`).
func foldWords(s string) []string {
	var out []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			out = append(out, string(cur))
			cur = cur[:0]
		}
	}
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
			// La tilde suelta que deja NFD: «ó» es «o» más esto.
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			cur = append(cur, r)
		default:
			flush()
		}
	}
	flush()
	return out
}
