package domain

import (
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
func SearchTSQuery(q string) string {
	terms := searchTerms(q)
	out := make([]string, len(terms))
	for i, t := range terms {
		out[i] = t.word
		if t.prefix {
			out[i] += ":*"
		}
	}
	return strings.Join(out, " & ")
}

// searchTerm: una palabra de la consulta, y si se busca por prefijo.
type searchTerm struct {
	word   string
	prefix bool
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
	for _, r := range strings.ToLower(q) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			cur = append(cur, r)
			continue
		}
		flush()
	}
	flush()
	if len(words) > 8 {
		words = words[:8]
	}
	out := make([]searchTerm, len(words))
	for i, w := range words {
		last := i == len(words)-1
		out[i] = searchTerm{word: w, prefix: last || len([]rune(w)) > ShortSearchWord}
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

// NothingForAnAgent: si no hubo acierto en lo que el MCP enseña (tareas, notas
// y docs). Personas, mensajes y directos no le llegan al agente, así que un
// acierto ahí no le sirvió de nada.
func (r SearchResults) NothingForAnAgent() bool {
	return len(r.Tasks) == 0 && len(r.Notes) == 0 && len(r.Docs) == 0
}
