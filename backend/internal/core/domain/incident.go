package domain

import (
	"regexp"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Incident es algo que ya mordió a alguien y le morderá al siguiente: qué
// falló, en qué servidor o en qué área, el commit que lo arregla y la prueba
// que lo guarda.
//
// Existe porque los tropiezos se quedaban como comentarios sueltos dentro de
// una tarea larga: los dieciséis del simulacro de gstd
// (command-and-control-283) vivían en el hilo de la 283, y quien tocara
// pixel-vps o k8s no los encontraba sin saber que habían pasado ahí. Atado a
// un servidor y a unas áreas, «qué ha mordido en pixel-vps» es una consulta,
// no una arqueología (command-and-control-289, decidido con jose el
// 2-nov-2026).
//
// Cuelga de un nodo, como una decisión, porque es documentación: el nodo es
// dónde se enseña («Trampas que ya han mordido» de su overview). Los
// servidores y las áreas son por dónde se encuentra.
//
// **Título y cuerpo no se editan.** Como en el registro de decisiones, lo que
// se escribió se queda: si estaba mal, se escribe otro que lo sustituye
// (`SupersedesID`) y el viejo deja de salir en el mapa y en la búsqueda. Lo que
// sí cambia es lo que pasa en el mundo después de escribirlo: el estado
// (abierto → arreglado, o al revés si vuelve) y lo que se le **añade** — un
// commit que llegó días después, la prueba que se escribió al final.
type Incident struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);not null;index" json:"orgId"`
	// DocID: el documento del nodo del que cuelga.
	DocID string `gorm:"type:varchar(36);not null;index" json:"-"`
	// Lo que mordió, en una línea: es lo que se lee en el mapa y en el aviso.
	Title string `gorm:"type:varchar(200);not null" json:"title"`
	// Qué pasó, por qué, y cómo quedó. Markdown.
	Body   string         `gorm:"type:text" json:"body"`
	Status IncidentStatus `gorm:"type:varchar(10);not null;default:open;index" json:"status"`
	// FixedAt: cuándo pasó a arreglado; nil mientras esté abierto.
	FixedAt      *time.Time `json:"fixedAt,omitempty"`
	OriginTaskID string     `gorm:"type:varchar(36);index" json:"originTaskId,omitempty"`
	AuthorID     string     `gorm:"type:varchar(36)" json:"authorId"`
	// Via: la app o un agente, en la fila, como en `Decision.Via`: lo que se
	// escribió no se borra, y quien lo lea dentro de un año tiene que poder
	// saber quién lo tecleó.
	Via          string `gorm:"type:varchar(20)" json:"via,omitempty"`
	SupersedesID string `gorm:"type:varchar(36);index" json:"supersedesId,omitempty"`
	// Keywords: los nombres de sus servidores y sus áreas, en texto, para que
	// entren en la búsqueda aunque el cuerpo no los nombre. Lo mantiene el
	// servicio cada vez que cambian; no se escribe a mano.
	Keywords string `gorm:"type:text" json:"-"`

	// Resuelto al leer.
	OwnerKind      DocOwnerKind        `gorm:"-" json:"ownerKind,omitempty"`
	OwnerID        string              `gorm:"-" json:"ownerId,omitempty"`
	OwnerName      string              `gorm:"-" json:"ownerName,omitempty"`
	AuthorName     string              `gorm:"-" json:"authorName,omitempty"`
	OriginRef      string              `gorm:"-" json:"originRef,omitempty"`
	OriginTitle    string              `gorm:"-" json:"originTitle,omitempty"`
	SupersededByID string              `gorm:"-" json:"supersededById,omitempty"`
	Servers        []IncidentServerRef `gorm:"-" json:"servers"`
	Areas          []string            `gorm:"-" json:"areas"`
	Commits        []IncidentCommit    `gorm:"-" json:"commits"`
	Guards         []string            `gorm:"-" json:"guards"`
}

type IncidentStatus string

const (
	IncidentOpen  IncidentStatus = "open"
	IncidentFixed IncidentStatus = "fixed"
)

func ValidIncidentStatus(s string) bool {
	return s == string(IncidentOpen) || s == string(IncidentFixed)
}

// IncidentServer ata un incidente a un servidor de su misma org.
type IncidentServer struct {
	IncidentID string `gorm:"type:varchar(36);primaryKey" json:"-"`
	ServerID   string `gorm:"type:varchar(36);primaryKey;index" json:"-"`
}

// IncidentServerRef: un servidor, como se enseña.
type IncidentServerRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// IncidentArea: un área de la que habla el incidente (`k8s`, `cert-manager`,
// `ssh`…), normalizada con `NormalizeIncidentArea`.
type IncidentArea struct {
	IncidentID string `gorm:"type:varchar(36);primaryKey" json:"-"`
	Area       string `gorm:"type:varchar(40);primaryKey;index" json:"-"`
}

// IncidentCommit: un commit que lo arregla (o que lo causó: lo dice el
// cuerpo). El título y el enlace salen de `task_git_links` cuando cac ya vio
// ese commit; si no, se guarda el sha pelado, que basta para `git show`.
type IncidentCommit struct {
	ID         string    `gorm:"type:varchar(36);primaryKey" json:"-"`
	IncidentID string    `gorm:"type:varchar(36);not null;uniqueIndex:idx_incident_commit" json:"-"`
	SHA        string    `gorm:"type:varchar(40);not null;uniqueIndex:idx_incident_commit" json:"sha"`
	Repo       string    `gorm:"type:varchar(200)" json:"repo,omitempty"`
	Title      string    `gorm:"type:varchar(200)" json:"title,omitempty"`
	HTMLURL    string    `gorm:"type:varchar(500)" json:"url,omitempty"`
	CreatedAt  time.Time `json:"addedAt"`
}

// IncidentGuard: la prueba que lo guarda, tal como se busca en el repo
// (`ansible::tests::cert_manager_can_clean_its_cloudflare_challenge`).
type IncidentGuard struct {
	ID         string    `gorm:"type:varchar(36);primaryKey" json:"-"`
	IncidentID string    `gorm:"type:varchar(36);not null;uniqueIndex:idx_incident_guard" json:"-"`
	Text       string    `gorm:"type:varchar(300);not null;uniqueIndex:idx_incident_guard" json:"-"`
	CreatedAt  time.Time `json:"-"`
}

// Lo que cabe en uno. Un incidente con treinta servidores no habla de
// ninguno: es una decisión de infraestructura.
const (
	IncidentMaxServers = 10
	IncidentMaxAreas   = 10
	IncidentMaxCommits = 20
	IncidentMaxGuards  = 20
)

// IncidentRequest: un incidente como lo manda quien lo apunta.
type IncidentRequest struct {
	Title string `json:"title" validate:"required,min=1,max=200"`
	Body  string `json:"body"`
	// Status: open si se omite. Lo arreglado se dice, no se adivina por tener
	// un commit: un commit puede ser sólo la mitad.
	Status string `json:"status" validate:"omitempty,oneof=open fixed"`
	// Servers: por id o por nombre, de la misma org.
	Servers []string `json:"servers" validate:"omitempty,max=10,dive,max=100"`
	Areas   []string `json:"areas"   validate:"omitempty,max=10,dive,max=60"`
	// Commits: `sha` o `owner/repo@sha`, de 7 a 40 caracteres hexadecimales.
	Commits      []string `json:"commits"      validate:"omitempty,max=20,dive,max=250"`
	Guards       []string `json:"guards"       validate:"omitempty,max=20,dive,max=300"`
	OriginTaskID string   `json:"originTaskId" validate:"omitempty,max=36"`
	Supersedes   string   `json:"supersedes"   validate:"omitempty,max=36"`
}

// IncidentAdditions: lo que se le añade a uno que ya existe. Sólo añade: es lo
// que puede hacer un token con `docs:write`.
type IncidentAdditions struct {
	Servers []string `json:"servers" validate:"omitempty,max=10,dive,max=100"`
	Areas   []string `json:"areas"   validate:"omitempty,max=10,dive,max=60"`
	Commits []string `json:"commits" validate:"omitempty,max=20,dive,max=250"`
	Guards  []string `json:"guards"  validate:"omitempty,max=20,dive,max=300"`
}

func (a IncidentAdditions) Empty() bool {
	return len(a.Servers) == 0 && len(a.Areas) == 0 && len(a.Commits) == 0 && len(a.Guards) == 0
}

// IncidentStatusPatch: cambiar el estado. Cambia, no añade: `docs:manage`.
type IncidentStatusPatch struct {
	Status string `json:"status" validate:"required,oneof=open fixed"`
}

// IncidentFilter: qué incidentes listar.
type IncidentFilter struct {
	OrgIDs []string
	// SpaceID: sólo los que cuelgan del espacio o de una carpeta o lista suya.
	SpaceID string
	// Node: sólo los que cuelgan de ese nodo (espacio, carpeta o lista), como
	// los enseña su overview.
	Node string
	// Server: un id o un nombre (sin distinguir mayúsculas).
	Server string
	Area   string
	Status string
	Since  *time.Time
	Limit  int
}

// IncidentListMax: el tope de una lista; lo que pasa de aquí se recorta y se
// dice (`truncated`).
const IncidentListMax = 200

// IncidentSummary: un incidente sin cuerpo, para listas, el mapa y los avisos.
type IncidentSummary struct {
	ID        string              `json:"id"`
	Title     string              `json:"title"`
	Status    IncidentStatus      `json:"status"`
	OrgID     string              `json:"orgId"`
	OwnerKind DocOwnerKind        `json:"ownerKind"`
	OwnerID   string              `json:"ownerId"`
	Servers   []IncidentServerRef `gorm:"-" json:"servers"`
	Areas     []string            `gorm:"-" json:"areas"`
	CreatedAt time.Time           `json:"recordedAt"`
	FixedAt   *time.Time          `json:"fixedAt,omitempty"`
}

var areaJunk = regexp.MustCompile(`[^a-z0-9.+-]+`)

// NormalizeIncidentArea: un área en minúsculas, sin acentos ni espacios, con guiones.
// «Cert Manager», «cert-manager» y «CERT_MANAGER» son la misma, y tienen que
// serlo: lo que la encuentra después es comparar palabras.
func NormalizeIncidentArea(s string) string {
	s = strings.ToLower(strings.TrimSpace(foldAccents(s)))
	s = areaJunk.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-.")
	if r := []rune(s); len(r) > 40 {
		s = strings.TrimRight(string(r[:40]), "-.")
	}
	return s
}

var commitRef = regexp.MustCompile(`^(?:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@)?([0-9a-fA-F]{7,40})$`)

// ParseCommitRef lee `sha` o `owner/repo@sha`. El sha va en minúsculas.
func ParseCommitRef(s string) (repo, sha string, ok bool) {
	m := commitRef.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return "", "", false
	}
	return m[1], strings.ToLower(m[2]), true
}

// IncidentKeywords: el texto que pone sus servidores y sus áreas en la
// búsqueda.
func IncidentKeywords(servers []string, areas []string) string {
	seen := map[string]bool{}
	var out []string
	for _, w := range append(append([]string{}, servers...), areas...) {
		w = strings.TrimSpace(w)
		if w == "" || seen[strings.ToLower(w)] {
			continue
		}
		seen[strings.ToLower(w)] = true
		out = append(out, w)
	}
	return strings.Join(out, " ")
}

// foldAccents quita las marcas de acento: «Configuración» → «Configuracion».
// Por descomposición (NFD) y no por una tabla, que se quedaba corta con
// cualquier letra que no fuera del castellano.
func foldAccents(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(s) {
		if !unicode.Is(unicode.Mn, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}
