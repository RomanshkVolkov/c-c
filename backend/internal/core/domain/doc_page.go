package domain

import (
	"time"

	"gorm.io/gorm"
)

// Páginas de documentación: un árbol que cuelga del doc de un nodo.
//
// El doc de un espacio, carpeta o lista sigue siendo **la portada**, con sus
// cuatro pestañas (ver `DocTabKey`). Debajo cuelgan las páginas que hagan
// falta, anidadas sin límite. Lo que había escrito no se mueve: es la capa que
// el comentario de `DocOwnerKind` dejaba prevista.
//
// Por qué hizo falta: en Proteus (dwit) se crearon cuatro listas vacías sólo
// para tener cuatro docs más, y la portada de una de ellas llegó a 133 000
// caracteres con cinco aplicaciones dentro. Un doc por nodo y cuatro pestañas
// fijas obligaban a eso; una página por tema es lo que cualquiera espera de una
// wiki.

// DocPage es una página del árbol de un documento.
//
// Se dirige **por id y nada más**: no hay slug. Moverla o renombrarla no cambia
// su enlace, que es lo que hace Confluence y lo que evita que un enlace pegado
// en un chat se rompa al reorganizar.
type DocPage struct {
	BaseModel
	DocID string `gorm:"type:varchar(36);not null;index:idx_docpage_tree,priority:1" json:"docId"`
	// Denormalizada como `Doc.OrgID`: la búsqueda y la valla van sin join.
	OrgID string `gorm:"type:varchar(36);not null;index" json:"orgId"`
	// ParentID nil = cuelga de la portada.
	ParentID *string `gorm:"type:varchar(36);index:idx_docpage_tree,priority:2" json:"parentId,omitempty"`
	Title    string  `gorm:"type:varchar(300);not null;default:''" json:"title"`
	// Rank es un `NUMERIC`, como todo rango de este repo (ver el paquete `rank`
	// y CLAUDE.md): un texto lo ordenaría la colación de la base.
	Rank          string `gorm:"type:numeric;not null;default:0.5" json:"rank"`
	Body          string `gorm:"type:text" json:"body"`
	BodyHash      string `gorm:"type:varchar(64)" json:"bodyHash,omitempty"`
	UpdatedBy     string `gorm:"type:varchar(36)" json:"updatedBy"`
	UpdatedByName string `gorm:"-" json:"updatedByName,omitempty"`
	// La papelera, como `Note.DeletedAt`: toda consulta normal la salta sola.
	// **No hay campo `Search`** aunque la tabla tenga esa columna: es una
	// columna generada (ver `repository.EnsureSearchIndexes`), y si el struct
	// la nombrara GORM intentaría escribirla y la inserción fallaría.
	DeletedAt gorm.DeletedAt `gorm:"index" json:"deletedAt"`
}

func (DocPage) TableName() string { return "doc_pages" }

// DocPageVersion es el texto de una página antes de un guardado.
//
// Tabla propia y no una columna más en `doc_versions`: allí la guarda
// anti-IDOR es «esta versión es de este documento», y para una página tiene que
// ser «es de esta página». Las reglas de cuándo se funde y cuántas se guardan
// son las mismas (`DocVersionMerges`, `DocVersionKeep`).
type DocPageVersion struct {
	BaseModel
	PageID     string `gorm:"type:varchar(36);not null;index" json:"pageId"`
	Title      string `gorm:"type:varchar(300)" json:"title"`
	Body       string `gorm:"type:text" json:"body"`
	AuthorID   string `gorm:"type:varchar(36)" json:"authorId"`
	AuthorName string `gorm:"-" json:"authorName,omitempty"`
}

func (DocPageVersion) TableName() string { return "doc_page_versions" }

// DocPageTreeItem es una fila del árbol: lo justo para pintarlo, sin cuerpos.
// Una portada de 133 000 caracteres partida en páginas sigue sumando lo mismo,
// y el árbol se pide cada vez que se abre el doc.
type DocPageTreeItem struct {
	ID        string    `json:"id"`
	ParentID  *string   `json:"parentId,omitempty"`
	Rank      string    `json:"rank"`
	Title     string    `json:"title"`
	HasBody   bool      `json:"hasBody"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// DocPageCrumb es un paso de las migas de pan.
type DocPageCrumb struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// DocPageView es una página abierta: ella, de dónde cuelga y qué cuelga de ella.
type DocPageView struct {
	Page *DocPage `json:"page"`
	// Breadcrumb va de la raíz a la madre, sin la propia página.
	Breadcrumb []DocPageCrumb    `json:"breadcrumb"`
	Children   []DocPageTreeItem `json:"children"`
	OrgID      string            `json:"orgId"`
}

// MaxDocBodyChars: lo más largo que puede ser una pestaña o una página.
//
// Hoy la mayor tiene 139 000. El tope existe porque el índice de búsqueda
// (tsvector) no admite más de 1 MB por fila, y sin él una inserción enorme
// fallaría en la base con un error que nadie entiende; con él, es un 413 que
// dice qué pasa.
const MaxDocBodyChars = 512_000

// DocBodyTooLong dice si un texto pasa del tope. En caracteres, no en bytes:
// un texto en castellano con tildes no tiene por qué pagar más que uno en inglés.
func DocBodyTooLong(body string) bool {
	if len(body) <= MaxDocBodyChars {
		return false
	}
	return len([]rune(body)) > MaxDocBodyChars
}

// PageMoveMakesACycle dice si mover `id` bajo `newParent` lo dejaría colgando
// de sí mismo. `parentOf` es el árbol actual: id → madre (nil = raíz).
//
// Pura y en el dominio para poder probarla sin base: el repositorio la usa
// además de su propia comprobación en SQL, que es la que vale con dos
// movimientos a la vez.
func PageMoveMakesACycle(parentOf map[string]*string, id string, newParent *string) bool {
	seen := map[string]bool{}
	for p := newParent; p != nil; p = parentOf[*p] {
		if *p == id {
			return true
		}
		if seen[*p] {
			// Un árbol ya roto no es este movimiento: se corta para no girar.
			return true
		}
		seen[*p] = true
	}
	return false
}

// ─── Peticiones ──────────────────────────────────────────────────────────────

type CreateDocPageRequest struct {
	Title    string  `json:"title" validate:"max=300"`
	ParentID *string `json:"parentId"`
	Body     string  `json:"body"`
	// AfterID: la hermana tras la que se coloca. Sin él, al final.
	AfterID *string `json:"afterId"`
}

// SaveDocPageRequest: lo que no venga no se toca. `BaseHash` es el hash del
// cuerpo que se leyó; sin él, si el servidor ya tiene uno, el guardado se
// rechaza (ver `DocSaveConflicts`).
type SaveDocPageRequest struct {
	Title    *string `json:"title" validate:"omitempty,max=300"`
	Body     *string `json:"body"`
	BaseHash *string `json:"baseHash"`
}

// MoveDocPageRequest: la nueva madre (nil = la portada) y junto a quién.
type MoveDocPageRequest struct {
	ParentID *string `json:"parentId"`
	AfterID  *string `json:"afterId"`
	BeforeID *string `json:"beforeId"`
}

type AppendDocPageRequest struct {
	Text string `json:"text" validate:"required"`
}
