package domain

import (
	"encoding/json"
	"strings"
	"time"
)

// ─── Hierarchy ────────────────────────────────────────────────────────────────
//
// Org → Space → (Folder) → List → Task. Folders are optional: a list can hang
// straight off a space. Ordering everywhere uses fractional ranks (see
// core/rank) so moving one item is a single-row update.

type TaskSpace struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	Name  string `gorm:"type:varchar(120);not null"      json:"name"`
	Color string `gorm:"type:varchar(20)"                json:"color"`
	Rank  string `gorm:"type:varchar(64);index"          json:"-"`
	// ProjectID binds everything under this space to a tenant's channel, unless a
	// list below says otherwise. Set here when a whole space is one client's work.
	ProjectID *string `gorm:"type:varchar(36);index" json:"projectId,omitempty"`
	// Kind distingue el espacio corriente ("") de la sala general de la
	// organización ("general"): un canal con su llamada y su hilo, anclado en
	// Channels y ausente del navegador de tareas.
	//
	// Cadena y no un bool: el valor ausente ya significa lo correcto para todas
	// las filas que ya existen —igual que `ParentFolderID`— y así no hace falta
	// tocar ninguna. Un bool habría necesitado `default:true` en algún sentido,
	// que en GORM es el terreno minado de siempre: omite el zero-value al
	// insertar y guarda lo contrario de lo que pediste.
	Kind string `gorm:"type:varchar(20);index" json:"kind,omitempty"`
}

// SpaceKindGeneral: la sala de toda la organización.
//
// No es una entidad aparte. Un espacio ya trae canal de chat y sala de voz por
// el hecho de existir, y sus permisos ya son de organización —no hay membresía
// por espacio—, así que lo único que la distingue es que **no tiene tareas**:
// ni listas, ni carpetas, ni sitio en el navegador de Tasks. Inventar una
// entidad paralela habría obligado a duplicar chat, presencia, timbre y media
// pantalla para no ganar nada.
const SpaceKindGeneral = "general"

type TaskFolder struct {
	BaseModel
	SpaceID string `gorm:"type:varchar(36);index;not null" json:"spaceId"`
	// ParentFolderID nil = the folder hangs off the space, which is what every
	// folder did before nesting existed. Added rather than backfilled for
	// exactly that reason: the absent value already means the right thing.
	ParentFolderID *string `gorm:"type:varchar(36);index" json:"parentFolderId,omitempty"`
	Name           string  `gorm:"type:varchar(120);not null" json:"name"`
	Rank           string  `gorm:"type:varchar(64);index"     json:"-"`
}

type TaskList struct {
	BaseModel
	SpaceID string `gorm:"type:varchar(36);index;not null" json:"spaceId"`
	// FolderID nil = the list sits directly under the space.
	FolderID *string `gorm:"type:varchar(36);index" json:"folderId,omitempty"`
	Name     string  `gorm:"type:varchar(120);not null" json:"name"`
	Rank     string  `gorm:"type:varchar(64);index"     json:"-"`
	// ProjectID binds this list to a tenant's channel and overrides the space's.
	//
	// Which way this points matters. It used to be the project that named its
	// list, and the migration had to guess one — it invented a "Reportes" space
	// per organization when portento already had a home of its own. Naming the
	// channel from the node you are looking at puts that choice where the person
	// making it can see the tree.
	ProjectID *string `gorm:"type:varchar(36);index" json:"projectId,omitempty"`
}

// ─── Board columns ────────────────────────────────────────────────────────────

// TaskStatusKind drives behaviour that shouldn't depend on a column's name:
// which column new tasks land in, and what counts as finished.
type TaskStatusKind string

const (
	StatusKindOpen   TaskStatusKind = "open"   // backlog / not started
	StatusKindActive TaskStatusKind = "active" // in progress
	StatusKindDone   TaskStatusKind = "done"   // closed
)

// TaskStatus is one board column, configurable per list — that's what makes the
// workflow yours instead of a fixed state machine like reports use.
type TaskStatus struct {
	BaseModel
	ListID string         `gorm:"type:varchar(36);index;not null" json:"listId"`
	Name   string         `gorm:"type:varchar(60);not null"       json:"name"`
	Color  string         `gorm:"type:varchar(20)"                json:"color"`
	Kind   TaskStatusKind `gorm:"type:varchar(20);default:'open'" json:"kind"`
	Rank   string         `gorm:"type:varchar(64);index"          json:"-"`
	// Status es el estado canónico que esta columna representa: `pending`,
	// `in_progress`, `resolved` o `closed`.
	//
	// No es una columna de la base de datos —las del tablero son sintéticas,
	// las construye `BoardStatuses`— y viaja al cliente porque sin él no hay
	// forma honesta de saber a cuál corresponde cada una. `Kind` no sirve:
	// «Done» y «Closed» son las dos `done`. La alternativa era que el cliente
	// partiera el id por la barra, o sea duplicar una regla del servidor en el
	// otro lado — que es exactamente cómo se inventan contratos que luego no
	// coinciden.
	Status ReportStatus `gorm:"-" json:"status"`
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

type TaskPriority string

const (
	PriorityNone   TaskPriority = "none"
	PriorityLow    TaskPriority = "low"
	PriorityNormal TaskPriority = "normal"
	PriorityHigh   TaskPriority = "high"
	PriorityUrgent TaskPriority = "urgent"
)

func (p TaskPriority) IsValid() bool {
	switch p {
	case PriorityNone, PriorityLow, PriorityNormal, PriorityHigh, PriorityUrgent:
		return true
	}
	return false
}

// Task is an Item with no channel — work raised inside cac.
//
// An alias rather than a struct of its own: one row, one set of rules. Two
// structs over one table drift, and the drift shows up as a default that applies
// on one write path and not the other.
//
// StatusID is gone with it. The configurable columns it pointed at don't exist
// any more, and every board that asked for one now gets a synthesised column —
// see domain.BoardStatuses.
type Task = Item

// TaskTag is an org-wide label pool, so tags stay consistent across spaces.
type TaskTag struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null;uniqueIndex:idx_tag_org_name" json:"orgId"`
	Name  string `gorm:"type:varchar(60);not null;uniqueIndex:idx_tag_org_name"       json:"name"`
	Color string `gorm:"type:varchar(20)" json:"color"`
}

type TaskTagLink struct {
	TaskID string `gorm:"type:varchar(36);primaryKey" json:"taskId"`
	TagID  string `gorm:"type:varchar(36);primaryKey" json:"tagId"`
}

// TaskAssignee is who on our side is responsible for an item.
//
// Not to be confused with the reporter. They are different people in different
// id spaces: a reporter lives in the tenant's, is asserted by them and never
// verified by us; an assignee is a cac user, which is why this one is checked
// against org membership and the other isn't.
//
// This table is the single home for that fact. It used to be two — this table
// for tasks and a column on the item for reports — so assigning from the board
// left the client's view unchanged, and assigning through their API left the
// board's avatars empty. Neither screen looked wrong on its own.
// ItemWatcher is somebody following a task they are not responsible for.
//
// Separate from assignment on purpose: "this is mine to do" and "tell me how
// this goes" are different sentences, and collapsing them would mean the only
// way to keep an eye on a task was to take it.
//
// No timestamps and no state: the row existing *is* the fact. A follow that
// could be half-on would need a rule for what half-on means.
type ItemWatcher struct {
	ItemID string `gorm:"type:varchar(36);primaryKey" json:"itemId"`
	UserID string `gorm:"type:varchar(36);primaryKey;index" json:"userId"`
}

type ItemAssignee struct {
	ItemID string `gorm:"type:varchar(36);primaryKey" json:"itemId"`
	UserID string `gorm:"type:varchar(36);primaryKey" json:"userId"`
	// Primary is who the tenant sees, because their contract names one person.
	//
	// Explicit rather than "the oldest row": this table has no timestamp, so
	// without a flag the answer would be whatever order Postgres felt like
	// returning — a different name on their board between two refreshes.
	Primary bool `gorm:"default:false;index" json:"primary"`
}

func (ItemAssignee) TableName() string { return "item_assignees" }

// TaskComment is an internal ItemComment: nobody outside cac ever reads one.
type TaskComment = ItemComment

// TaskAttachment is an ItemAttachment on the internal side: served through the
// authenticated proxy rather than a signed link. CommentID set = attached to a
// comment; nil = attached to the item itself.
type TaskAttachment = ItemAttachment

// AttachmentRef is the canonical reference stored in markdown and returned to
// clients: our own proxy, relative so the same description resolves against
// whichever backend the app is pointed at.
func AttachmentRef(taskID, attachmentID string) string {
	return "/api/v1/tasks/" + taskID + "/attachments/" + attachmentID + "/raw"
}

// NormalizeURL points an attachment at the proxy. Rows written before the proxy
// existed hold the bucket URL, which no client can load (the bucket denies
// anonymous reads) — this makes those rows serve like new ones.
func (a *TaskAttachment) NormalizeURL() {
	if !strings.HasPrefix(a.URL, "/api/") {
		a.URL = AttachmentRef(a.ItemID, a.ID)
	}
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

// DocOwnerKind is the node a document describes. One document per node: the
// "overview" of a space, a folder or a list. A multi-page tree can be layered on
// top later without moving these rows.
type DocOwnerKind string

const (
	DocOwnerSpace  DocOwnerKind = "space"
	DocOwnerFolder DocOwnerKind = "folder"
	DocOwnerList   DocOwnerKind = "list"
)

func ValidDocOwnerKind(k string) bool {
	switch DocOwnerKind(k) {
	case DocOwnerSpace, DocOwnerFolder, DocOwnerList:
		return true
	}
	return false
}

type Doc struct {
	BaseModel
	// Denormalized so authorization and listing don't have to walk the tree.
	OrgID     string       `gorm:"type:varchar(36);index;not null"                json:"orgId"`
	OwnerKind DocOwnerKind `gorm:"type:varchar(20);not null;index:idx_doc_owner,unique" json:"ownerKind"`
	OwnerID   string       `gorm:"type:varchar(36);not null;index:idx_doc_owner,unique" json:"ownerId"`
	// Markdown, same format tasks use, so one editor and one renderer serve both.
	Body          string `gorm:"type:text" json:"body"`
	UpdatedBy     string `gorm:"type:varchar(36)" json:"updatedBy"`
	UpdatedByName string `gorm:"-" json:"updatedByName,omitempty"`

	// Quién responde de este documento.
	//
	// El nombre es desafortunado y es a propósito: `OwnerKind`/`OwnerID` de
	// arriba son el **nodo** del que cuelga el documento, no una persona.
	// Renombrar aquéllos es una migración que este cambio no necesita, así que
	// la persona se llama `Maintainer` en el modelo y «Owner» en la pantalla,
	// que es como la llama quien la usa.
	MaintainerID   string `gorm:"type:varchar(36);index" json:"maintainerId,omitempty"`
	MaintainerName string `gorm:"-"                      json:"maintainerName,omitempty"`

	// Cuándo alguien confirmó por última vez que esto sigue siendo verdad.
	//
	// Distinto de `UpdatedAt`: editar no es revisar. Se puede corregir una errata
	// sin comprobar que los pasos siguen funcionando, y es justo la diferencia
	// que hace útil el aviso.
	ReviewedAt     *time.Time `json:"reviewedAt,omitempty"`
	ReviewedBy     string     `gorm:"type:varchar(36)" json:"reviewedBy,omitempty"`
	ReviewedByName string     `gorm:"-"                json:"reviewedByName,omitempty"`

	// Una línea sobre el tablero: lo que hay que saber antes de coger una tarjeta.
	//
	// Corta a la fuerza. Si cupiera un párrafo se llenaría de párrafos, y un
	// banner que se lee se convierte en un banner que se ignora.
	PinnedLine string `gorm:"type:varchar(280)" json:"pinnedLine,omitempty"`

	// Calculado, no guardado: depende de qué día es hoy. Guardarlo obligaría a
	// una tarea que recorriera la tabla cada noche para poner al día algo que se
	// deduce de una resta.
	Stale bool `gorm:"-" json:"stale"`
}

// DocMark es lo que el navegador necesita saber de un documento sin cargarlo.
//
// Era un booleano —«tiene documentación o no»— y se quedó corto en cuanto la
// línea fijada tuvo que aparecer sobre el tablero: el tablero no carga el
// documento, y hacerle una petición más por cada lista para leer una línea de
// texto es un coste que no hace falta pagar. Se resuelve en la consulta que ya
// recorre todos los documentos de la organización.
//
// Sigue siendo *verdadero* en JSON para un cliente antiguo, que sólo mira si la
// clave está: un objeto también es verdadero.
type DocMark struct {
	Written    bool   `json:"written"`
	PinnedLine string `json:"pinnedLine,omitempty"`
	Stale      bool   `json:"stale,omitempty"`
	// Dueño y revisión, para el índice de la organización.
	//
	// Aquí y no en una ruta propia porque el índice no necesita nada más: el
	// árbol —con los nombres, las rutas y los recuentos de tarjetas— ya lo tiene
	// el cliente cargado para pintar el navegador. Una consulta nueva volvería a
	// recorrer la misma jerarquía para devolver lo que ya está en memoria.
	MaintainerID   string     `json:"maintainerId,omitempty"`
	MaintainerName string     `json:"maintainerName,omitempty"`
	ReviewedAt     *time.Time `json:"reviewedAt,omitempty"`
}

// DocStaleAfter es cuánto aguanta un documento sin que nadie lo confirme.
//
// Noventa días porque es el orden de magnitud en que un runbook deja de ser
// verdad sin que nadie lo note: un cambio de host, una variable nueva, un paso
// que ya no hace falta. Menos, y el aviso salta tan a menudo que se aprende a
// no verlo.
const DocStaleAfter = 90 * 24 * time.Hour

// DocIsStale dice si hace falta que alguien vuelva a mirarlo.
//
// Un documento que **nunca** se revisó no está viejo por eso: acaba de
// escribirse. Teñir de ámbar algo escrito ayer enseña a ignorar el color, que es
// exactamente lo que no puede pasar. Sin revisión se cuenta desde que se
// escribió, que es cuando se supo por última vez que era verdad.
func DocIsStale(reviewedAt *time.Time, writtenAt, now time.Time) bool {
	desde := writtenAt
	if reviewedAt != nil {
		desde = *reviewedAt
	}
	if desde.IsZero() {
		return false
	}
	return now.Sub(desde) >= DocStaleAfter
}

// DocTabKey nombra cada una de las cuatro secciones de un documento.
//
// Fijas y en este orden, y **ninguna se oculta cuando está vacía**: su ausencia
// es información. Que un proyecto no tenga runbook es un dato sobre el proyecto,
// no una pestaña que estorbe.
type DocTabKey string

const (
	DocOverview  DocTabKey = "overview"
	DocRunbook   DocTabKey = "runbook"
	DocDecisions DocTabKey = "decisions"
	DocLinks     DocTabKey = "links"
)

// DocTabKeys es el orden en que se pintan, y la lista que valida una petición.
var DocTabKeys = []DocTabKey{DocOverview, DocRunbook, DocDecisions, DocLinks}

// IsDocTabKey evita que una ruta invente una sección.
func IsDocTabKey(k string) bool {
	for _, v := range DocTabKeys {
		if string(v) == k {
			return true
		}
	}
	return false
}

// ResolveDocTabs completa lo que la base devolvió hasta las cuatro secciones.
//
// Pura y en el dominio, no dentro de la consulta, porque es **la regla** y no un
// detalle de almacenamiento: siempre están las cuatro y siempre en este orden,
// también las vacías. Una pestaña sin contenido se pinta en gris y no se oculta,
// porque su ausencia dice algo del proyecto — que no tiene runbook es un dato.
//
// Aparte también para poder probarla: las pruebas de repositorio de este
// proyecto se saltan cuando no hay base de datos, y en integración continua no
// hay ninguna. Una regla que sólo se comprueba en la máquina de quien la escribió
// no está comprobada.
func ResolveDocTabs(docID string, stored []DocTab) []DocTab {
	byKey := make(map[DocTabKey]DocTab, len(stored))
	for _, t := range stored {
		byKey[t.Key] = t
	}
	out := make([]DocTab, 0, len(DocTabKeys))
	for _, k := range DocTabKeys {
		if t, ok := byKey[k]; ok {
			out = append(out, t)
			continue
		}
		out = append(out, DocTab{DocID: docID, Key: k})
	}
	return out
}

// DocTab es una sección de un documento.
//
// Tabla aparte y no cuatro columnas en `Doc` por dos razones que llegan después:
// cada pestaña tendrá su propia procedencia —una puede ser el reflejo de un
// `.md` de un repositorio mientras las otras se escriben a mano— y su propia
// frescura, porque «quién tocó esto por última vez» se pregunta por sección y no
// por documento entero.
type DocTab struct {
	BaseModel
	DocID string    `gorm:"type:varchar(36);not null;index:idx_doctab,unique" json:"docId"`
	Key   DocTabKey `gorm:"type:varchar(20);not null;index:idx_doctab,unique" json:"key"`
	// Markdown, el mismo formato que usan las tareas: un editor y un renderizador
	// sirven para los dos.
	Body string `gorm:"type:text" json:"body"`
	// BodyHash es de qué versión viene lo que se está leyendo.
	//
	// Quien guarda lo devuelve, y si para entonces el del servidor ya es otro es
	// que alguien guardó en medio: aplicar el nuevo encima borraría lo suyo sin
	// que nadie se entere. Con un agente escribiendo por MCP mientras una persona
	// tiene el documento abierto, eso deja de ser un caso raro.
	BodyHash      string `gorm:"type:varchar(64)" json:"bodyHash,omitempty"`
	UpdatedBy     string `gorm:"type:varchar(36)" json:"updatedBy"`
	UpdatedByName string `gorm:"-" json:"updatedByName,omitempty"`
}

// DocSaveConflicts dice si un guardado llega tarde.
//
// Pura y en el dominio porque es **la regla** que decide si se pierde texto, y
// porque las pruebas de repositorio de este proyecto se saltan sin base de datos
// — en integración continua no hay ninguna, así que una regla comprobada sólo
// ahí no está comprobada.
//
// Se mira `actual` y no `base`: una sección sin hash todavía —nunca guardada, o
// escrita antes de que esto existiera— no tiene contra qué comparar y no puede
// producir un conflicto falso. Pero en cuanto el servidor **sí** tiene uno, quien
// no manda ninguno está exactamente igual de atrasado que quien manda uno
// equivocado: su copia es anterior al primer hash que se escribió, que sigue
// siendo una versión que no vio.
func DocSaveConflicts(actual string, base *string) bool {
	if actual == "" {
		return false
	}
	return base == nil || *base != actual
}

// DocVersion es una foto de una sección tal como se guardó.
//
// Existe por el autoguardado, no a pesar de él: escribir sin un botón de guardar
// sólo es cómodo si equivocarse tiene vuelta atrás. Sin historial, el
// autoguardado convierte un borrado accidental en algo irrecuperable, que es
// peor que el botón que quitó.
type DocVersion struct {
	BaseModel
	DocID string    `gorm:"type:varchar(36);not null;index:idx_docver,priority:1" json:"docId"`
	Key   DocTabKey `gorm:"type:varchar(20);not null;index:idx_docver,priority:2" json:"key"`
	// El texto **anterior** al guardado, no el nuevo.
	//
	// Una versión sirve para volver, y a lo que se quiere volver es a lo que
	// había antes de la edición que salió mal. Guardar el estado nuevo obligaría
	// a leer la fila siguiente para restaurar, y la última no tendría ninguna.
	Body       string `gorm:"type:text" json:"body"`
	AuthorID   string `gorm:"type:varchar(36)" json:"authorId"`
	AuthorName string `gorm:"-"               json:"authorName,omitempty"`
}

// DocVersionMerge es cuánto se agrupan los guardados de una misma persona.
//
// El autoguardado dispara cada pocos segundos: una fila por pulsación deja un
// historial de trescientas entradas por tarde, que es un historial que no se
// puede leer y por tanto no sirve para volver a ningún sitio. Dentro de esta
// ventana se reescribe la última fila en vez de añadir otra, así que lo que
// queda es «una sesión de escritura, una entrada».
//
// Diez minutos porque es la escala a la que un cambio deja de ser «lo que estoy
// escribiendo» y pasa a ser «lo que escribí antes».
const DocVersionMerge = 10 * time.Minute

// DocVersionMerges dice si un guardado se funde con la última entrada.
//
// La regla, aparte de la consulta que la usa, por la misma razón que
// `ResolveDocTabs`: las pruebas de repositorio se saltan sin base de datos y en
// integración continua no hay ninguna. Y ésta decide si el historial se puede
// leer o no, que es lo único que lo hace útil.
//
// Se funde sólo con **la misma persona**: dos autores en la misma ventana son
// dos cambios distintos, y agruparlos borraría de quién fue cada uno, que es la
// mitad de para qué sirve el historial.
func DocVersionMerges(last *DocVersion, userID string, now time.Time) bool {
	if last == nil || last.AuthorID != userID {
		return false
	}
	return now.Sub(last.CreatedAt) < DocVersionMerge
}

// DocVersionKeep es cuántas entradas se conservan por sección.
//
// Un tope y no un borrado por antigüedad: lo que hace falta es poder volver unos
// cuantos pasos, y una sección que nadie toca en un año no tiene por qué perder
// su historia sólo porque el año pasó.
const DocVersionKeep = 50

// DecisionOrigin dice de dónde salió una decisión.
//
// Obligatorio, y ésa es la regla que le da valor a la pestaña. Una decisión sin
// procedencia es una frase suelta: dentro de tres meses nadie sabrá qué se
// discutió para llegar a ella, y lo que se hace con una frase que no se puede
// comprobar es ignorarla.
type DecisionOrigin string

const (
	DecisionFromTask    DecisionOrigin = "task"
	DecisionFromMessage DecisionOrigin = "message"
	// DecisionFromDoc: escrita en la propia pestaña. También es una procedencia
	// —«se decidió aquí»— y no la ausencia de una.
	DecisionFromDoc DecisionOrigin = "doc"
)

// Decision es una entrada del registro de un documento.
//
// **Append-only.** No hay editar ni borrar, y no es una carencia: un registro
// que se puede reescribir no es un registro. Se corrige añadiendo, que además
// deja ver que hubo una corrección — que suele ser el dato interesante.
type Decision struct {
	BaseModel
	DocID string `gorm:"type:varchar(36);not null;index" json:"docId"`
	// Lo que se decidió, en una línea. El cuerpo es el porqué.
	Title      string    `gorm:"type:varchar(200);not null" json:"title"`
	Body       string    `gorm:"type:text"                  json:"body"`
	Tag        string    `gorm:"type:varchar(40)"           json:"tag,omitempty"`
	AuthorID   string    `gorm:"type:varchar(36)"           json:"authorId"`
	AuthorName string    `gorm:"-"                          json:"authorName,omitempty"`
	DecidedAt  time.Time `json:"decidedAt"`

	Origin          DecisionOrigin `gorm:"type:varchar(20);not null" json:"origin"`
	OriginTaskID    string         `gorm:"type:varchar(36)"          json:"originTaskId,omitempty"`
	OriginMessageID string         `gorm:"type:varchar(36)"          json:"originMessageId,omitempty"`
	OriginChannelID string         `gorm:"type:varchar(36)"          json:"originChannelId,omitempty"`
	// Resueltos al leer, para que el enlace de vuelta se pueda pintar con
	// palabras y no con un identificador.
	OriginTitle string `gorm:"-" json:"originTitle,omitempty"`

	// Con qué comentario se escribió, y sólo para no escribirla dos veces.
	//
	// No es la procedencia —ésa es la tarea, que es lo que alguien querría
	// abrir—: es la clave que hace que un reintento no deje dos entradas
	// idénticas en un registro del que no se puede borrar nada.
	OriginCommentID string `gorm:"type:varchar(36)" json:"-"`

	// Via dice por dónde entró: la app, o un agente por MCP.
	//
	// En la fila y no sólo en el aviso, al contrario que en el resto del
	// codebase, porque este registro **no se puede borrar**. Quien lo lea dentro
	// de un año tiene que poder distinguir lo que tecleó una persona de lo que
	// transcribió un agente, y para entonces el aviso hace mucho que se leyó.
	Via string `gorm:"type:varchar(20)" json:"via,omitempty"`
}

// DecisionRequest es una decisión tal como la manda quien la toma.
type DecisionRequest struct {
	Title string `json:"title" validate:"required,min=1,max=200"`
	Body  string `json:"body"  validate:"omitempty"`
	Tag   string `json:"tag"   validate:"omitempty,max=40"`
	// El origen es obligatorio: ver el comentario de `DecisionOrigin`.
	Origin          string `json:"origin"          validate:"required,oneof=task message doc"`
	OriginTaskID    string `json:"originTaskId"    validate:"omitempty,max=36"`
	OriginMessageID string `json:"originMessageId" validate:"omitempty,max=36"`
	OriginChannelID string `json:"originChannelId" validate:"omitempty,max=36"`
	// DecidedBy es quién la tomó, cuando no es quien la escribe.
	//
	// El caso que lo pide: la decisión se tomó fuera de cac —un correo, una
	// llamada— y quien la apunta es un agente. Firmarla con el dueño del token
	// diría que la tomó él, que es falso y además es lo que alguien creerá
	// cuando la lea. Se acepta el nombre o el usuario de un miembro de la
	// organización; el servidor lo resuelve.
	DecidedBy string `json:"decidedBy" validate:"omitempty,max=120"`
}

// DocPatchSignsAReview dice si este cambio incluye firmar una revisión.
//
// Con nombre propio y aquí porque es una **firma**, no un campo más: dice que una
// persona confirmó que el documento sigue siendo verdad, y por eso el handler la
// exige de un superadmin mientras no haya rol de admin de organización.
//
// Mira el puntero y no su valor. Quitar una revisión —`false`— también cambia lo
// que el documento afirma sobre sí mismo: deja en verde algo que estaba en ámbar,
// o al revés. Guardar sólo el caso `true` es el error fácil, y deja media puerta
// abierta.
func DocPatchSignsAReview(r PatchDocRequest) bool {
	return r.Reviewed != nil
}

// DecisionIsAddressed comprueba que el origen trae con qué volver.
//
// «task» sin id de tarea es lo mismo que no tener origen: el enlace de vuelta no
// lleva a ninguna parte. Se comprueba aquí y no con etiquetas de validación
// porque la regla es condicional —qué campo hace falta depende de cuál sea el
// origen— y expresarla en una etiqueta la deja ilegible.
func DecisionIsAddressed(r DecisionRequest) bool {
	switch DecisionOrigin(r.Origin) {
	case DecisionFromTask:
		return r.OriginTaskID != ""
	case DecisionFromMessage:
		return r.OriginMessageID != ""
	case DecisionFromDoc:
		return true
	}
	return false
}

// DocAttachment is a file cited from a document.
//
// Kept apart from TaskAttachment instead of making that table polymorphic: the
// task one is live in production with rows whose URLs are already written inside
// saved markdown, and loosening its NOT NULL task_id is a migration this feature
// doesn't need. The streaming and authorization code is shared.
type DocAttachment struct {
	BaseModel
	DocID       string `gorm:"type:varchar(36);index;not null" json:"docId"`
	URL         string `gorm:"type:text;not null"              json:"url"`
	Path        string `gorm:"type:text"                       json:"-"`
	FileName    string `gorm:"type:varchar(255)"               json:"fileName"`
	ContentType string `gorm:"type:varchar(120)"               json:"contentType"`
	Bytes       int64  `json:"bytes"`
	UploadedBy  string `gorm:"type:varchar(36)" json:"uploadedBy"`
}

// DocAttachmentRef mirrors AttachmentRef: relative on purpose.
func DocAttachmentRef(docID, attachmentID string) string {
	return "/api/v1/docs/" + docID + "/attachments/" + attachmentID + "/raw"
}

func (a *DocAttachment) NormalizeURL() {
	if !strings.HasPrefix(a.URL, "/api/") {
		a.URL = DocAttachmentRef(a.DocID, a.ID)
	}
}

type SaveDocRequest struct {
	Body string `json:"body"`
	// BaseHash es el `bodyHash` que traía la sección al leerla. Ver
	// `DocSaveConflicts`. Se ignora al añadir al final: ahí no hay nada que pisar.
	BaseHash *string `json:"baseHash"`
}

// PatchDocRequest cambia lo que rodea al documento, no su texto.
//
// Todo puntero: sin el campo no se toca nada, que es lo que permite mandar sólo
// lo que se editó. Un `""` explícito sí borra — quitar el responsable o la línea
// fijada tiene que ser posible.
//
// `Reviewed` es un booleano y no una fecha a propósito. «Marcar revisado» es la
// acción; dejar que el cliente ponga la fecha que quiera le deja mentir sobre la
// frescura, y que el dato sea cierto es todo el valor que tiene el chip.
type PatchDocRequest struct {
	MaintainerID *string `json:"maintainerId" validate:"omitempty,max=36"`
	// Maintainer es el mismo campo, dicho por su nombre.
	//
	// Dos campos y no uno que adivine: la app tiene el id porque acaba de
	// pintar la lista de gente, y un agente sólo tiene «Jose Guzman». Aceptar
	// las dos cosas en un solo campo obliga a decidir por la forma de la
	// cadena, que es cómo se acaba tratando el nombre de alguien como un
	// identificador fallido.
	Maintainer *string `json:"maintainer" validate:"omitempty,max=120"`
	PinnedLine *string `json:"pinnedLine"   validate:"omitempty,max=280"`
	Reviewed   *bool   `json:"reviewed"`
}

// ─── Requests ─────────────────────────────────────────────────────────────────

type CreateSpaceRequest struct {
	OrgID string `json:"orgId" validate:"required"`
	Name  string `json:"name"  validate:"required,min=1,max=120"`
	Color string `json:"color" validate:"omitempty,max=20"`
}

type RenameRequest struct {
	Name  string `json:"name"  validate:"required,min=1,max=120"`
	Color string `json:"color" validate:"omitempty,max=20"`
	// ProjectID binds the node to a tenant's channel. A pointer because absent
	// and empty mean different things: leaving it out renames without touching
	// the binding, sending "" clears it.
	ProjectID *string `json:"projectId" validate:"omitempty,max=36"`
}

type CreateFolderRequest struct {
	Name string `json:"name" validate:"required,min=1,max=120"`
	// ParentFolderID nests the new folder inside another. Absent — the only
	// thing that was possible before folders could hold folders — puts it
	// straight under the space.
	ParentFolderID *string `json:"parentFolderId"`
}

type CreateListRequest struct {
	Name      string  `json:"name"     validate:"required,min=1,max=120"`
	FolderID  *string `json:"folderId"`
	ProjectID *string `json:"projectId" validate:"omitempty,max=36"`
}

type CreateStatusRequest struct {
	Name  string         `json:"name" validate:"required,min=1,max=60"`
	Color string         `json:"color" validate:"omitempty,max=20"`
	Kind  TaskStatusKind `json:"kind" validate:"omitempty,oneof=open active done"`
}

type UpdateStatusRequest struct {
	Name  string         `json:"name"  validate:"required,min=1,max=60"`
	Color string         `json:"color" validate:"omitempty,max=20"`
	Kind  TaskStatusKind `json:"kind"  validate:"omitempty,oneof=open active done"`
}

// ItemVisibilityChoice is what someone picks when raising work in a list that
// belongs to a client's channel.
//
// Absent means visible. That is the deliberate default: what the team is working
// on should be something the client can see, and hiding it is the decision that
// has to be made on purpose. A list with no channel ignores this entirely —
// there is nobody outside to show it to.
type CreateTaskRequest struct {
	Title string `json:"title"    validate:"required,min=1,max=300"`
	// IdempotencyKey makes a retry safe: the same key in the same list returns
	// the task that was already created instead of a second copy. An automated
	// caller whose request times out has no other way to tell "it didn't happen"
	// from "the reply got lost".
	IdempotencyKey string `json:"idempotencyKey" validate:"omitempty,max=120"`
	// Visibility is the choice made when raising work in a list that belongs to a
	// client's channel: "" or "public" means they see it — and it takes a folio
	// from their numbering and fires their webhook — while "internal" keeps it to
	// us.
	//
	// Absent means visible, deliberately. What the team is working on should be
	// something the client can see; hiding a piece of it is the decision that has
	// to be made on purpose. In a list with no channel this is ignored: there is
	// nobody outside to show it to.
	Visibility ItemVisibility `json:"visibility" validate:"omitempty,oneof=internal public"`
	// Markdown body, so a task can be filed complete in one call (the MCP tool
	// does exactly that).
	Description string       `json:"description"`
	StatusID    string       `json:"statusId"`
	Priority    ItemPriority `json:"priority" validate:"omitempty,oneof=none low normal high urgent"`
	// ParentID creates this task as a subtask of another one.
	ParentID string `json:"parentId"`
	// DueAt and AssigneeIDs are accepted at creation, not only on the edit that
	// follows. The composer asks for all of it in one row, and making the client
	// create-then-patch would mean a task that exists for a moment with nobody
	// on it and no date — visible to everyone watching, and wrong.
	DueAt       *time.Time `json:"dueAt"`
	AssigneeIDs []string   `json:"assigneeIds"`
}

// UpdateTaskRequest patches a task; nil fields are left untouched so the client
// can send just what changed.
type UpdateTaskRequest struct {
	Title       *string       `json:"title"       validate:"omitempty,min=1,max=300"`
	Description *string       `json:"description"`
	Priority    *TaskPriority `json:"priority"    validate:"omitempty,oneof=none low normal high urgent"`
	StartAt     *time.Time    `json:"startAt"`
	DueAt       *time.Time    `json:"dueAt"`
	// Nil leaves membership alone; an empty slice clears it.
	TagIDs      *[]string `json:"tagIds"`
	AssigneeIDs *[]string `json:"assigneeIds"`
	Archived    *bool     `json:"archived"`
	// Visibility takes a published item back, or hands an internal one over.
	//
	// It exists because publishing is a mistake someone will make: the choice is
	// at creation time and defaults to visible, so the first time anyone gets it
	// wrong the item is already on a client's board. Without a way back the only
	// remedy was editing the database.
	//
	// Retracting does not give the folio back. A number handed out is spent — the
	// client may have quoted it — so their numbering keeps the gap. That is the
	// honest outcome, not a bug to fix later.
	Visibility *ItemVisibility `json:"visibility" validate:"omitempty,oneof=internal public"`
	// ListID moves the card to another list, which is how work gets tidied up
	// after the fact — a report that landed in the wrong place, a task filed in
	// haste. Both lists must belong to the same organization: a card crossing that
	// line would become visible to people who cannot see where it came from.
	ListID *string `json:"listId" validate:"omitempty,max=36"`
}

// MoveTaskRequest places a task between two neighbours in a column. The server
// derives the rank, so clients never compute ordering.
type MoveTaskRequest struct {
	StatusID string `json:"statusId" validate:"required"`
	AfterID  string `json:"afterId"`  // task it should follow (empty = top)
	BeforeID string `json:"beforeId"` // task it should precede (empty = bottom)
}

// MoveNodeRequest reorders a space/folder/list among its siblings.
type MoveNodeRequest struct {
	AfterID  string `json:"afterId"`
	BeforeID string `json:"beforeId"`
	// FolderID is the folder the node lands in, and nil takes it out to the
	// space. It reads the same for both kinds — a list into a folder, a folder
	// into another folder — which is why nesting needed no second field.
	FolderID *string `json:"folderId"`
}

type CreateTagRequest struct {
	OrgID string `json:"orgId" validate:"required"`
	Name  string `json:"name"  validate:"required,min=1,max=60"`
	Color string `json:"color" validate:"omitempty,max=20"`
}

type TaskCommentRequest struct {
	Body string `json:"body" validate:"required,min=1"`
	// Visibility follows the same rule as raising the work in the first place: on
	// something a client can see, saying nothing means they read it too. Send
	// "internal" for a note between us.
	//
	// On an item no client can see this is ignored — there is nobody to show it
	// to, and every comment is internal by definition.
	Visibility ItemVisibility `json:"visibility" validate:"omitempty,oneof=internal public"`
	// Decision convierte este comentario en una entrada del registro del
	// proyecto, además de publicarlo.
	//
	// En la misma petición y no en dos: son un solo gesto —«esto se decidió»— y
	// partirlo deja el estado a medias cuando la segunda falla, que en un
	// registro del que no se puede borrar es peor que no haberlo escrito.
	Decision *DecisionRequest `json:"decision" validate:"omitempty"`
}

// ─── Responses ────────────────────────────────────────────────────────────────

// EnsureGeneralSpaceRequest pide la sala general de una organización.
type EnsureGeneralSpaceRequest struct {
	OrgID string `json:"orgId" validate:"required"`
}

// SpaceTree is the whole left-hand navigator in one round-trip.
type SpaceTree struct {
	ID        string `json:"id"`
	OrgID     string `json:"orgId"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	ProjectID string `json:"projectId,omitempty"`
	// Kind viaja para que la app sepa cuál anclar arriba en Channels y cuál
	// esconder en el navegador de tareas. Ver domain.SpaceKindGeneral.
	Kind    string        `json:"kind,omitempty"`
	Folders []FolderTree  `json:"folders"`
	Lists   []ListSummary `json:"lists"` // lists directly under the space
	// People es quién tiene trabajo asignado aquí dentro. Es la única
	// pertenencia real que tiene un espacio: no hay tabla de miembros por
	// espacio —quien está en la organización llega a todos— así que «quién está
	// en este sitio» sólo se puede responder por lo que la gente carga.
	People []SpacePerson `json:"people"`
}

// SpacePerson es una cara en la ficha de un espacio: lo justo para dibujarla.
type SpacePerson struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	// Name es el nombre con el que se le llama a alguien, y va **junto al**
	// usuario, no en su lugar.
	//
	// El usuario es el identificador: es lo que se escribe tras una arroba, lo
	// que se busca en el selector, y lo que no cambia. El nombre es cómo se lee.
	// Enseñar «rvolkov» donde cabe «Romanshk Volkov» hace que una lista de gente
	// se lea como una tabla de la base de datos.
	//
	// Puede venir vacío —nadie está obligado a ponerlo— y quien lo pinte tiene
	// que caer al usuario. Ver `nombreDe` en el cliente.
	Name string `json:"name,omitempty"`
}

type FolderTree struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Folders []FolderTree  `json:"folders"`
	Lists   []ListSummary `json:"lists"`
}

type ListSummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// OpenCount son las que quedan por hacer, frente a TaskCount que son todas
	// las vivas. Las dos, porque «9 de 48» dice algo que ninguna sola dice.
	OpenCount int64 `json:"openCount"`
	// ProjectID is the channel this list belongs to, if any — either its own
	// binding or the one it inherits from its space. Sent so the navigator can
	// say which lists a client can see into, rather than leaving that invisible.
	ProjectID string `json:"projectId,omitempty"`
	TaskCount int64  `json:"taskCount"`
}

type TaskCard struct {
	ID              string       `json:"id"`
	Seq             int          `json:"seq"`
	Title           string       `json:"title"`
	Priority        ItemPriority `json:"priority"`
	StatusID        string       `json:"statusId"`
	DueAt           *time.Time   `json:"dueAt,omitempty"`
	HasDescription  bool         `json:"hasDescription"`
	CommentCount    int64        `json:"commentCount"`
	AttachmentCount int64        `json:"attachmentCount"`
	// Subtask progress, so a card shows its breakdown without being opened.
	SubtaskCount int64         `json:"subtaskCount"`
	SubtaskDone  int64         `json:"subtaskDone"`
	Tags         []TaskTag     `json:"tags"`
	Assignees    []UserSummary `json:"assignees"`
	UpdatedAt    time.Time     `json:"updatedAt"`
	// Category and Area are the report taxonomy, on the card so the board can
	// filter by them without opening anything. Empty on work raised inside cac,
	// which nobody classifies this way.
	Category string `json:"category,omitempty"`
	Area     string `json:"area,omitempty"`
	// CreatedAt drives the calendar view, which groups by the day something was
	// filed — the question that view answers is "what came in that week".
	CreatedAt time.Time `json:"createdAt"`
}

type BoardResponse struct {
	List     ListSummary  `json:"list"`
	Statuses []TaskStatus `json:"statuses"`
	Tasks    []TaskCard   `json:"tasks"`
}

// OpenTask is one line of the dashboard's "what's pending" list: enough to
// recognise a task and jump to it, and no more.
//
// Deliberately not a TaskCard. That one carries tags, comment and attachment
// counts and subtask progress — four extra queries per board — which is right
// for a board you work in and wasteful for a summary you glance at. It also
// crosses lists, which the board never does, so it names the list and space a
// task came from.
// OpenTaskFilter is "my work", expressed as the few questions a person actually
// asks: what is mine, what did I raise, what am I following, and what is due.
//
// Every field is optional and they combine with AND. Empty means the dashboard
// list that existed before any of this.
type OpenTaskFilter struct {
	// AssigneeID, CreatorID and WatcherID each narrow to one person. They are
	// ids and not a "me" flag so the same query can answer for somebody else
	// later without a second endpoint.
	AssigneeID string
	CreatorID  string
	WatcherID  string
	// IncludeClosed brings back resolved and closed work, which the list hides
	// by default: "what is pending" is the question it exists to answer.
	IncludeClosed bool
	// Origin picks work by where it came from. Client-facing items are hidden
	// by default because this list is the team's own board and a tenant's
	// tickets have their own screen; "clients" asks for exactly those instead.
	Origin  OpenTaskOrigin
	DueFrom *time.Time
	DueTo   *time.Time
}

// OpenTaskOrigin: work raised inside cac, work that came from a client, or
// both. Three named values rather than a pair of booleans, because "neither"
// would be a question with no answer.
type OpenTaskOrigin string

const (
	OriginInternal OpenTaskOrigin = ""        // the default: our own work
	OriginClients  OpenTaskOrigin = "clients" // only what came through a channel
	OriginAny      OpenTaskOrigin = "any"
)

type OpenTask struct {
	ID       string       `json:"id"`
	Seq      int          `json:"seq"`
	Title    string       `json:"title"`
	Priority ItemPriority `json:"priority"`
	DueAt    *time.Time   `json:"dueAt,omitempty"`
	// Status is the raw state, scanned from the row; the two fields under it are
	// rendered from it for clients that still read column names.
	//
	// Viaja, y no se queda dentro: la clase agrupa `done` y `closed` bajo la
	// misma etiqueta, así que un tablero que se guiara por ella no podría
	// separar lo terminado de lo cerrado —y «cerrada» es un estado que llega de
	// verdad por la integración server-to-server, no un adorno—.
	Status     ReportStatus   `json:"status"`
	StatusName string         `json:"statusName"`
	StatusKind TaskStatusKind `json:"statusKind"`
	ListID     string         `json:"listId"`
	ListName   string         `json:"listName"`
	SpaceID    string         `json:"spaceId"`
	SpaceName  string         `json:"spaceName"`
	UpdatedAt  time.Time      `json:"updatedAt"`
	// Subtasks, as done/total. A card that says 1/3 is telling you the thing
	// you would otherwise have to open it to find out.
	SubtasksDone  int64 `json:"subtasksDone"`
	SubtasksTotal int64 `json:"subtasksTotal"`
	// Assignee is who it belongs to, by name. The name and not the id, because
	// what a card shows is initials, and resolving ids to people in the client
	// would mean holding a directory it has no other use for.
	Assignee string `json:"assignee,omitempty"`
	// Folio is the client-facing number, when this came through a channel. A
	// card raised in cac shows its `seq`; one that belongs to a tenant shows the
	// number *they* see, because that is the one anybody will quote at you.
	Folio string `json:"folio,omitempty"`
}

type TaskCommentResponse struct {
	ID string `json:"id"`
	// Author is the same tagged author the report thread returns, because it is
	// the same thread. Resolving it here from null-ness instead is what left the
	// client's own replies nameless on the board — see tagAuthor, which exists
	// so exactly one place answers this question.
	Author       *CommentAuthor `json:"author,omitempty" gorm:"-"`
	AuthorUserID string         `json:"authorUserId"`
	AuthorName   string         `json:"authorName"`
	// Visibility is sent on every comment so the thread can say, line by line,
	// who is reading it. Without it a board full of replies looks identical
	// whether the client can see them or not, and the only way to find out is to
	// open their side and compare.
	Visibility ItemVisibility `json:"visibility"`
	// Kind marks the ones the system wrote ("status: x → y") so they can be drawn
	// as events rather than as somebody's words.
	Kind        ReportCommentKind `json:"kind"`
	Body        string            `json:"body"`
	Attachments []TaskAttachment  `json:"attachments"`
	CreatedAt   time.Time         `json:"createdAt"`
	UpdatedAt   time.Time         `json:"updatedAt"`
}

type TaskDetail struct {
	Task        Task                  `json:"task"`
	ListName    string                `json:"listName"`
	SpaceName   string                `json:"spaceName"`
	Status      TaskStatus            `json:"status"`
	Tags        []TaskTag             `json:"tags"`
	Assignees   []UserSummary         `json:"assignees"`
	Comments    []TaskCommentResponse `json:"comments"`
	Attachments []TaskAttachment      `json:"attachments"`
	Subtasks    []TaskCard            `json:"subtasks"`
	/** Set when this task is itself a subtask, so the drawer can link back. */
	Parent *TaskCard `json:"parent,omitempty"`
	// Folio and ProjectSlug are how a client's ticket is named — "portento-89".
	// Empty for work raised inside cac, which numbers per space and has no
	// channel to name. Derived, not stored: see Folio().
	Folio       string `json:"folio,omitempty"`
	ProjectSlug string `json:"projectSlug,omitempty"`
	// Telemetry is the decrypted breadcrumbs blob, when the report carried one
	// and it hasn't been purged. The report facade has always returned this; the
	// board could not show what led up to a bug without it.
	Telemetry json.RawMessage `json:"telemetry,omitempty"`
}
