package domain

import "time"

// ─── El mapa de contexto de un espacio, para un agente ───────────────────────
//
// Lo que el equipo sabe de un proyecto, en una sola respuesta y **sin
// cuerpos**: el árbol de carpetas y listas, de cada nodo los títulos de su
// documentación y de sus decisiones, los `.md` de los repos atados y lo que
// está en curso. Con eso, un agente sabe qué sección leer antes de leer nada.
//
// Antes eran cinco o seis llamadas (el navegador, el índice de cada doc, sus
// páginas, los docs del repo, el tablero de cada lista) y la primera pregunta
// era «¿en qué lista va este repo?». El repo se resuelve aquí desde su nombre
// en GitHub (`GitHubRepo.SpaceID`), que es lo que sabe un agente: el remote de
// la carpeta donde trabaja.

// ContextMap es la respuesta entera.
type ContextMap struct {
	Space ContextSpace `json:"space"`
	// Repo: el repo por el que se resolvió el espacio, si se pidió así.
	Repo *ContextRepo `json:"repo,omitempty"`
	// Nodes: el espacio, sus carpetas y sus listas, en el orden del navegador.
	Nodes []ContextNode `json:"nodes"`
	// RepoDocs: los markdown de los repos atados al espacio, sólo ruta y título.
	RepoDocs []ContextRepoDoc `json:"repoDocs"`
	// InProgress: lo que está en la columna «en curso» de cualquier lista del
	// espacio, lo más reciente primero. Para no duplicar una tarea que ya existe.
	InProgress []ContextTask `json:"inProgress"`
	// Truncated dice qué se recortó por tamaño, para no confundirlo con «no hay».
	Truncated []string `json:"truncated,omitempty"`
}

type ContextSpace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Key: cómo se nombran sus tareas en un commit o una rama: `<key>-<número>`.
	Key     string `json:"key,omitempty"`
	OrgID   string `json:"orgId"`
	OrgName string `json:"orgName,omitempty"`
}

type ContextRepo struct {
	FullName string `json:"fullName"`
}

// ContextNode: un espacio, una carpeta o una lista. `Path` es su ruta desde el
// espacio («Clientes › Acme»). `ProjectID`, en una lista, dice que es de un
// cliente: lo que se cree ahí lo ve él.
type ContextNode struct {
	Kind      DocOwnerKind `json:"kind"`
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Path      string       `json:"path"`
	ProjectID string       `json:"projectId,omitempty"`
	OpenCount int          `json:"openCount,omitempty"`
	Doc       *ContextDoc  `json:"doc,omitempty"`
}

// ContextDoc: el índice del documento de un nodo. Sin cuerpos: para leer, el
// agente pide la sección con `get_doc(tab, section)`.
type ContextDoc struct {
	Maintainer string            `json:"maintainer,omitempty"`
	ReviewedAt *time.Time        `json:"reviewedAt,omitempty"`
	Stale      bool              `json:"stale,omitempty"`
	Tabs       []ContextTab      `json:"tabs"`
	Pages      []ContextPage     `json:"pages,omitempty"`
	Decisions  []ContextDecision `json:"decisions,omitempty"`
}

// ContextTab: una pestaña con contenido, su tamaño y sus títulos (hasta el
// nivel 3). Las pestañas vacías no salen.
type ContextTab struct {
	Key      DocTabKey         `json:"key"`
	Chars    int               `json:"chars"`
	Headings []MarkdownHeading `json:"headings"`
}

type ContextPage struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	ParentID *string `json:"parentId,omitempty"`
}

// ContextDecision: una decisión **vigente**. Las sustituidas (ver
// `Decision.SupersedesID`) no salen: el mapa dice lo que vale hoy; el registro
// entero, con su historia, se lee con el documento.
type ContextDecision struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Tag       string    `json:"tag,omitempty"`
	DecidedAt time.Time `json:"decidedAt"`
}

type ContextRepoDoc struct {
	ID    string `json:"id"`
	Repo  string `json:"repo"`
	Path  string `json:"path"`
	Title string `json:"title"`
}

type ContextTask struct {
	ID  string `json:"id"`
	Seq int    `json:"seq"`
	// Ref: cómo se nombra en un commit (`proteus-12`, o el folio de un cliente).
	Ref       string    `json:"ref,omitempty"`
	Title     string    `json:"title"`
	ListID    string    `json:"listId"`
	ProjectID string    `json:"-"`
	Assignees []string  `json:"assignees,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Handoff: el «dónde quedó» de la tarea (Item.Handoff), con quién lo
	// escribió y cuándo. Con esto, al poner el tablero al día no hace falta
	// abrir cada tarea: hasta el 22-oct-2026 eran cuatro `get_task` de varios
	// miles de caracteres para encontrar una línea.
	Handoff     string     `json:"handoff,omitempty"`
	HandoffAt   *time.Time `json:"handoffAt,omitempty"`
	HandoffByID string     `json:"-"`
	HandoffBy   string     `json:"handoffBy,omitempty"`
}

// Límites del mapa: lo que pasa de aquí se recorta y se dice en `Truncated`.
// Un mapa que no cabe en el contexto de un agente es el problema que resuelve.
const (
	ContextMaxHeadingLevel = 3
	ContextMaxPagesPerDoc  = 40
	ContextMaxDecisions    = 15
	ContextMaxRepoDocs     = 80
	ContextMaxInProgress   = 30
)
