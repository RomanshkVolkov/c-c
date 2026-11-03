package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode"
)

// SearchHit is one thing found, in whatever it was found in.
//
// Flat and small on purpose: the palette shows a line and jumps somewhere, so
// anything richer would be shipping content nobody asked to read. In particular
// no message or DM body travels here — a hit says *that* something matched and
// where, not what it said.
//
// Llevan `Snippet` —el trozo donde aparece lo buscado— sólo las fuentes cuya
// valla es la misma que la de quien busca, así que el fragmento no le enseña
// nada que no pudiera abrir:
//   - la documentación (la organización): una página de 130 000 caracteres que
//     «contiene» la palabra no dice nada sin ver dónde;
//   - la **descripción** de una tarea (la organización), nunca un comentario:
//     un comentario puede ser interno, y su trozo fuera del hilo es lo que no
//     se hace;
//   - una nota (su dueño, que es quien busca).
//
// Mensajes y DMs siguen sin texto: su valla es el canal o las dos personas, no
// la organización.
type SearchHit struct {
	Kind  SearchKind `json:"kind"`
	ID    string     `json:"id"`
	Title string     `json:"title"`
	// Where is human context: the list a task lives in, the channel a message
	// was in, the person a conversation is with.
	Where string `json:"where,omitempty"`
	// Link is the in-app route this jumps to.
	Link string `json:"link"`
	// OrgID es la organización de lo encontrado; vacío en lo que no es de
	// ninguna (una nota). La app la necesita para abrirlo **en su org**: un
	// enlace a algo de otra org cambia de org antes de abrirlo, y sin esto no
	// sabría a cuál.
	OrgID string `json:"orgId,omitempty"`
	// Snippet: el trozo donde aparece lo buscado, con las coincidencias entre
	// `**`. Sólo donde la valla lo permite (ver arriba).
	Snippet string `json:"snippet,omitempty"`
	// Dónde está un acierto de documentación, para que un agente no tenga que
	// desmontar el enlace: el nodo, la pestaña (en la portada) o la página.
	OwnerKind string `json:"ownerKind,omitempty"`
	OwnerID   string `json:"ownerId,omitempty"`
	Tab       string `json:"tab,omitempty"`
	PageID    string `json:"pageId,omitempty"`
	// Section: el título bajo el que cae lo buscado (`SearchSection`), para
	// leer sólo esa sección con `get_doc(tab, section)` o `get_doc_page`.
	Section string `json:"section,omitempty"`
}

type SearchKind string

const (
	SearchTask    SearchKind = "task"
	SearchNote    SearchKind = "note"
	SearchPerson  SearchKind = "person"
	SearchMessage SearchKind = "message"
	SearchDM      SearchKind = "dm"
	SearchDoc     SearchKind = "doc"
	// SearchRepoDoc: un .md de un repo atado a un espacio (docs as code). Va
	// con los docs: es documentación de la org, con su misma valla.
	SearchRepoDoc SearchKind = "repoDoc"
	// SearchDecision: una entrada vigente del registro de decisiones de un
	// documento. Va con los docs: es documentación, y hasta el 22-oct-2026 lo
	// que se apuntaba «para leerse dentro de un año» no lo encontraba nadie.
	SearchDecision SearchKind = "decision"
	// SearchIncident: algo que ya mordió (domain.Incident), vigente. Va con
	// los docs, con su misma valla: la organización.
	SearchIncident SearchKind = "incident"
)

// SearchResults keeps the sources apart all the way to the client.
//
// Not one merged list, and this is the whole design. Every source here has a
// different rule about who may see it: a task is the organization's, a note is
// one person's, a channel message is readable by everyone in that channel, and
// a direct message is readable by exactly two people. A single ranked list
// would mean one query joining across all of them, and the first person to add
// a source would have to rediscover four different authorization rules to keep
// it honest. Kept apart, each one is queried by a function that can only see
// what that source allows.
type SearchResults struct {
	Tasks    []SearchHit `json:"tasks"`
	Notes    []SearchHit `json:"notes"`
	People   []SearchHit `json:"people"`
	Messages []SearchHit `json:"messages"`
	DMs      []SearchHit `json:"dms"`
	// Docs va aparte igual que el resto, y por la misma razón: aunque hoy la
	// documentación se lea con pertenecer a la organización —como una tarea—,
	// mezclarla en la lista de tareas ataría las dos reglas a la misma consulta,
	// y la de documentación es la que va a cambiar si algún día hay permisos por
	// documento.
	Docs []SearchHit `json:"docs"`
	// Partial: nada casaba con todas las palabras y esto casa con **alguna**
	// (ver SearchTSQueryWith). Para que quien lo lee —sobre todo un agente—
	// no lo tome por la respuesta a lo que preguntó.
	Partial bool `json:"partial,omitempty"`
}

// SearchTSQuery convierte lo que escribe alguien en una consulta de texto
// completo: cada palabra **por prefijo** y todas a la vez.
//
// Por prefijo porque es lo que se espera de una caja de búsqueda: «pocna»
// encuentra `pocna-jobs`, «desplieg» encuentra «despliegues» — y porque el
// índice no lematiza (`cac_simple`), así que los plurales los cubre esto.
//
// **Salvo las palabras de una o dos letras**, que cuentan sólo enteras: por
// prefijo, «de» encontraba «después» y «desprogramó», y en «puerta de
// verificación» la mitad de los aciertos salían por eso (21-oct-2026). La
// última palabra sí va por prefijo aunque sea corta, porque en la paleta es la
// que se está escribiendo: «puerta d» tiene que seguir encontrando algo.
//
// Sólo letras y dígitos sobreviven. Los operadores de `to_tsquery` (`&`, `|`,
// `!`, `:`, `(`, comillas) harían que Postgres rechazara la consulta con un
// error, y una búsqueda que revienta porque alguien pegó un `!=` es peor que
// una que lo ignora. Pura, para poder probarla sin base.
//
// **Una referencia (`proteus-125`, `tds-69`, `command-and-control-221`) va
// entera y sin prefijo.** Postgres guarda «PROTEUS-125» como `proteus` y
// `-125` —lee el guion como un signo—, así que partirla en `proteus` y `125`
// no casaba nunca con la tarea que la nombra, y sí con cualquier documento que
// dijera «Proteus» en un sitio y «125 vistas» en otro. Un agente que preguntó
// por una tarea de Jira recibió una página de documentación (22-oct-2026).
// Entera, `to_tsquery` la convierte en la frase exacta: ni `proteus-1250` ni
// «125 vistas».
func SearchTSQuery(q string) string {
	return SearchTSQueryWith(q, nil, false)
}

// SearchTSQueryWith es SearchTSQuery con dos ayudas para lo que busca un
// agente, que escribe frases y no palabras clave (command-and-control-294):
//
//   - `stems`: la raíz de cada palabra (de `SearchStemWords`, calculada por
//     Postgres con `spanish_stem`). Una palabra con raíz casa por cualquiera de
//     las dos, ambas por prefijo: «publicación» encuentra «publicar» y
//     «publicado». El índice no lematiza (`cac_simple`) y no se toca: la raíz
//     va sólo en la consulta, así que no hay nada que reindexar. Sin esto,
//     «riesgos publicación» no encontraba nada y «riesgos publicar» tres
//     tareas (`search_misses`, 2-nov-2026).
//   - `anyWord`: con alguna de las palabras en vez de con todas. Es la segunda
//     vuelta cuando todas a la vez no dan nada: «allowlist staff_allowlist
//     aprobar briefing kyle» no daba nada y «kyle» solo, dieciséis. Ordenado
//     por relevancia, lo que casa con más palabras sube.
func SearchTSQueryWith(q string, stems map[string]string, anyWord bool) string {
	terms := searchTerms(q)
	out := make([]string, len(terms))
	for i, t := range terms {
		out[i] = t.word
		if t.prefix {
			out[i] += ":*"
		}
		if st, ok := stems[t.word]; ok && t.prefix && validStem(t.word, st) {
			out[i] = "(" + out[i] + " | " + st + ":*)"
		}
	}
	if anyWord {
		return strings.Join(out, " | ")
	}
	return strings.Join(out, " & ")
}

// MinStemWord: desde cuántas letras una palabra se busca también por su raíz.
// MinStem: la raíz más corta que se usa. «casa» da «cas», que por prefijo
// casaría con «caso» y «castillo»: una raíz corta trae más ruido que ayuda.
const (
	MinStemWord = 5
	MinStem     = 4
)

// SearchStemWords: las palabras de la consulta que se buscan también por su
// raíz. Ni las referencias ni las cortas.
func SearchStemWords(q string) []string {
	var out []string
	for _, t := range searchTerms(q) {
		if !t.ref && t.prefix && len([]rune(t.word)) >= MinStemWord {
			out = append(out, t.word)
		}
	}
	return out
}

// validStem: una raíz que aporta algo y que `to_tsquery` no puede leer mal:
// sólo letras y dígitos, no más corta que MinStem y distinta de la palabra.
func validStem(word, stem string) bool {
	if len([]rune(stem)) < MinStem || stem == word {
		return false
	}
	for _, r := range stem {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// SearchWordCount: cuántas palabras tiene la consulta, contadas como las
// cuenta la búsqueda. Con una sola no hay segunda vuelta «con alguna».
func SearchWordCount(q string) int { return len(searchTerms(q)) }

// SearchID: si la consulta es sólo un id (un uuid), en minúsculas. Un agente
// pega el id que le dio otra herramienta (`1b0add6d-…`), y el texto completo
// lo parte en trozos que no casan con nada (`search_misses`, 2-nov-2026): se
// busca la cosa que se llama así.
func SearchID(q string) (string, bool) {
	q = strings.ToLower(strings.TrimSpace(q))
	if len(q) != 36 {
		return "", false
	}
	for i, c := range q {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return "", false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return "", false
			}
		}
	}
	return q, true
}

// searchTerm: una palabra de la consulta, y si se busca por prefijo. `ref`:
// es una referencia `clave-número`, que va entera (ver SearchTSQuery).
type searchTerm struct {
	word   string
	prefix bool
	ref    bool
}

// isRefWord: `letras…-número`, en minúsculas, con tramos separados por guion,
// el primero empezando por letra y el último sólo dígitos. Es la forma de una
// clave de Jira y de una referencia de cac.
func isRefWord(w string) bool {
	parts := strings.Split(w, "-")
	if len(parts) < 2 || parts[0] == "" || parts[0][0] < 'a' || parts[0][0] > 'z' {
		return false
	}
	for i, p := range parts {
		if p == "" {
			return false
		}
		for j := 0; j < len(p); j++ {
			c := p[j]
			digit := c >= '0' && c <= '9'
			if i == len(parts)-1 && !digit {
				return false
			}
			if !digit && (c < 'a' || c > 'z') {
				return false
			}
		}
	}
	return true
}

// ShortSearchWord: hasta cuántas letras una palabra cuenta sólo entera.
const ShortSearchWord = 2

// searchTerms: las palabras de una consulta (como mucho ocho), con la regla
// de `SearchTSQuery`. La comparte `SearchSection`, para que la sección de un
// acierto se elija con las mismas palabras que lo encontraron.
func searchTerms(q string) []searchTerm {
	var words []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			words = append(words, string(cur))
			cur = cur[:0]
		}
	}
	// El guion se queda dentro de la palabra para poder reconocer una
	// referencia; si no lo es, se vuelve a partir por él, como siempre.
	for _, r := range strings.ToLower(q) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || (r == '-' && len(cur) > 0) {
			cur = append(cur, r)
			continue
		}
		flush()
	}
	flush()
	type word struct {
		text string
		ref  bool
	}
	var split []word
	for _, w := range words {
		w = strings.Trim(w, "-")
		if isRefWord(w) {
			split = append(split, word{w, true})
			continue
		}
		for _, p := range strings.Split(w, "-") {
			if p != "" {
				split = append(split, word{p, false})
			}
		}
	}
	if len(split) > 8 {
		split = split[:8]
	}
	out := make([]searchTerm, len(split))
	for i, w := range split {
		if w.ref {
			out[i] = searchTerm{word: w.text, ref: true}
			continue
		}
		last := i == len(split)-1
		out[i] = searchTerm{word: w.text, prefix: last || len([]rune(w.text)) > ShortSearchWord}
	}
	return out
}

// SearchMiss: una búsqueda de un agente que no encontró nada.
//
// Para decidir con datos si hace falta búsqueda semántica (embeddings): la de
// texto completo no sabe que «cómo despliego» y «soltar una release» hablan de
// lo mismo, pero no sabemos cuánto falla de verdad. Esto lo cuenta. Sólo las del
// MCP: una persona que no encuentra algo reformula en el momento; un agente
// suele rendirse y leer documentos enteros, que es lo que se quiere evitar.
// Se guarda la consulta tal cual (la escribió alguien del equipo con su token)
// y se poda a los 90 días.
type SearchMiss struct {
	ID        string    `gorm:"type:varchar(36);primaryKey" json:"id"`
	UserID    string    `gorm:"type:varchar(36);index;not null" json:"userId"`
	OrgID     string    `gorm:"type:varchar(36);index" json:"orgId"`
	Query     string    `gorm:"type:varchar(200);not null" json:"query"`
	CreatedAt time.Time `gorm:"index" json:"createdAt"`
}

// SearchMissSummary: una consulta fallida, con cuántas veces y la última.
// Es lo que se revisa para decidir si hace falta búsqueda por significado
// (decisión 82f9678a): agrupadas se ve qué falla de verdad, y no cien filas.
type SearchMissSummary struct {
	Query  string    `json:"query"`
	Count  int       `json:"count"`
	LastAt time.Time `json:"lastAt"`
	OrgID  string    `json:"orgId,omitempty"`
}

// NothingForAnAgent: si no hubo acierto en lo que el MCP enseña (tareas, notas
// y docs). Personas, mensajes y directos no le llegan al agente, así que un
// acierto ahí no le sirvió de nada.
func (r SearchResults) NothingForAnAgent() bool {
	return len(r.Tasks) == 0 && len(r.Notes) == 0 && len(r.Docs) == 0
}

// Las marcas con las que Postgres señala lo encontrado en un fragmento
// (`ts_headline` con StartSel/StopSel). Unas que no salen en un documento: con
// `**`, la marca se mezclaba con la negrita que ya traía el markdown y el
// fragmento llegaba roto («**407 **de** 412**», 21-oct-2026).
const (
	HighlightStart = "⟦"
	HighlightStop  = "⟧"
)

// SnippetLT: lo que va en lugar de `<` mientras Postgres arma el fragmento. El
// analizador de texto toma `<número>` por una etiqueta HTML y `ts_headline` la
// quita: en un `.md`, «`clave-<número>`» salía «`clave- `» (22-oct-2026). Un
// carácter de uso privado de Unicode, que no aparece en un texto, y
// `CleanSnippet` lo devuelve a `<`. Lo pone `replace(…, '<', chr(57344))` en
// `repository/search.go`.
const SnippetLT = "\uE000"

// CleanSnippet: el fragmento con lo encontrado entre `**` y nada más en
// negrita. Quita la negrita `**` que traía el documento, que en un fragmento
// de una línea no dice nada, y sólo entonces pone la marca. `__` se deja: en un
// fragmento de código es parte de un nombre (`__init__`), no negrita.
func CleanSnippet(s string) string {
	s = strings.ReplaceAll(s, "**", "")
	// Dos resaltados pegados son una sola palabra: Postgres marca «PROTEUS» y
	// «-125» por separado, y salía `**PROTEUS****-125**` (22-oct-2026).
	s = strings.ReplaceAll(s, HighlightStop+HighlightStart, "")
	s = strings.ReplaceAll(s, HighlightStart, "**")
	s = strings.ReplaceAll(s, SnippetLT, "<")
	return strings.ReplaceAll(s, HighlightStop, "**")
}

// SubtaskMaxParentTitle: hasta cuántas letras del título de la madre caben en
// el «dónde» de una subtarea.
const SubtaskMaxParentTitle = 40

// SubtaskWhere: el «dónde» de una subtarea en la búsqueda: su lista y la
// tarea de la que cuelga, `Backend › #289 Lo que mordió se registra…`. El
// título se recorta por letras, no por bytes: una «ñ» partida sería basura.
func SubtaskWhere(list string, parentSeq int, parentTitle string) string {
	t := []rune(strings.TrimSpace(parentTitle))
	if len(t) > SubtaskMaxParentTitle {
		t = append(t[:SubtaskMaxParentTitle], '…')
	}
	return fmt.Sprintf("%s › #%d %s", list, parentSeq, string(t))
}
