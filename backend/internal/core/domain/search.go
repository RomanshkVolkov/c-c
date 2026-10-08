package domain

import (
	"strings"
	"unicode"
)

// SearchHit is one thing found, in whatever it was found in.
//
// Flat and small on purpose: the palette shows a line and jumps somewhere, so
// anything richer would be shipping content nobody asked to read. In particular
// no message or DM body travels here — a hit says *that* something matched and
// where, not what it said.
//
// La documentación es la excepción, y sólo ella: lleva `Snippet`, el trozo
// donde aparece lo buscado. Una página de 130 000 caracteres que «contiene»
// la palabra no dice nada sin ver dónde; y la valla de un doc es la
// organización, la misma que la de quien busca, así que el fragmento no le
// enseña nada que no pudiera abrir. Mensajes y DMs siguen sin texto: su valla
// es el canal o las dos personas, no la organización.
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
	// `**`. Sólo en documentación (ver arriba).
	Snippet string `json:"snippet,omitempty"`
	// Dónde está un acierto de documentación, para que un agente no tenga que
	// desmontar el enlace: el nodo, la pestaña (en la portada) o la página.
	OwnerKind string `json:"ownerKind,omitempty"`
	OwnerID   string `json:"ownerId,omitempty"`
	Tab       string `json:"tab,omitempty"`
	PageID    string `json:"pageId,omitempty"`
}

type SearchKind string

const (
	SearchTask    SearchKind = "task"
	SearchNote    SearchKind = "note"
	SearchPerson  SearchKind = "person"
	SearchMessage SearchKind = "message"
	SearchDM      SearchKind = "dm"
	SearchDoc     SearchKind = "doc"
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
// Sólo letras y dígitos sobreviven. Los operadores de `to_tsquery` (`&`, `|`,
// `!`, `:`, `(`, comillas) harían que Postgres rechazara la consulta con un
// error, y una búsqueda que revienta porque alguien pegó un `!=` es peor que
// una que lo ignora. Pura, para poder probarla sin base.
func SearchTSQuery(q string) string {
	var terms []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			terms = append(terms, string(cur)+":*")
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
	if len(terms) > 8 {
		terms = terms[:8]
	}
	return strings.Join(terms, " & ")
}
