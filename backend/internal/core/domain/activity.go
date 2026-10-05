package domain

import "time"

// ─── Actividad de CI (R9) ─────────────────────────────────────────────────────
//
// Cada ejecución de GitHub Actions de un repo de la org queda apuntada aquí,
// con su estado actual: quién la disparó, en qué rama, de qué commit, cómo va
// y cómo acabó. Es lo que enseña la página de Actividad y lo que suena en la
// campana cuando termina. GitHub manda `workflow_run` tres veces por intento
// —requested, in_progress, completed— y cada una **actualiza** la misma fila.
//
// Sólo repos de la org: un `workflow_run` de un repo que la instalación deja
// ver pero que ninguna org ha atado no se apunta. Un run no es de nadie hasta
// que su repo lo es.

// WorkflowRun: un intento de una ejecución de GitHub Actions.
//
// **Una fila por intento, no por ejecución.** Un re-run desde GitHub reutiliza
// el `id` del run y sube `run_attempt`; si la clave fuera sólo el id, el
// segundo intento pisaría al primero y la lista diría que el CI pasó a la
// primera cuando no fue así.
type WorkflowRun struct {
	BaseModel
	// OrgID es el de la org del repo en el momento de apuntar. Va en la fila y
	// no por join: si la instalación se suelta, lo que pasó sigue siendo de quien
	// era.
	OrgID        string `gorm:"type:varchar(36);index:idx_workflow_runs_feed,priority:1;not null" json:"orgId"`
	RepoID       int64  `gorm:"index;not null" json:"repoId"`
	RepoFullName string `gorm:"type:varchar(200);not null" json:"repoFullName"`
	RunID        int64  `gorm:"uniqueIndex:idx_workflow_runs_attempt;not null" json:"runId"`
	RunAttempt   int    `gorm:"uniqueIndex:idx_workflow_runs_attempt;not null;default:1" json:"runAttempt"`
	RunNumber    int    `json:"runNumber"`
	WorkflowName string `gorm:"type:varchar(200)" json:"workflowName"`
	// Path: `.github/workflows/prod.yml`. Es lo que casa con
	// `Deployable.BuildWorkflow`, no el nombre, que se puede repetir.
	Path string `gorm:"type:varchar(300)" json:"path"`
	// Event: qué disparó el workflow (`push`, `pull_request`, `workflow_dispatch`…).
	Event string `gorm:"type:varchar(40)" json:"event"`
	// Status: requested | queued | in_progress | waiting | pending | completed.
	// Conclusion sólo tiene valor con `completed`: success | failure | cancelled |
	// skipped | timed_out | action_required | neutral | stale | startup_failure.
	Status     string `gorm:"type:varchar(20);not null" json:"status"`
	Conclusion string `gorm:"type:varchar(30)" json:"conclusion"`
	// StatusRank es la guarda del upsert: ver WorkflowRunRank. No se enseña.
	StatusRank int16  `gorm:"not null;default:1" json:"-"`
	HeadSha    string `gorm:"type:varchar(40)" json:"headSha"`
	HeadBranch string `gorm:"type:varchar(200)" json:"headBranch"`
	// CommitTitle: la primera línea del mensaje del commit, que es lo que una
	// persona lee para saber qué se estaba probando.
	CommitTitle string `gorm:"type:varchar(200)" json:"commitTitle"`
	// Actor: quien lo disparó. Para un re-run, quien lo relanzó
	// (`triggering_actor`), no el autor del push original.
	Actor   string `gorm:"type:varchar(120)" json:"actor"`
	HTMLURL string `gorm:"type:varchar(400)" json:"htmlUrl"`
	// OccurredAt es el `created_at` del run en GitHub, **no** el de la fila ni
	// el del último webhook: es el instante que ordena el feed, y no puede
	// moverse cuando llega el `completed` o la fila saltaría de sitio mientras
	// alguien la mira.
	OccurredAt   time.Time  `gorm:"index:idx_workflow_runs_feed,priority:2;not null" json:"occurredAt"`
	RunStartedAt *time.Time `json:"runStartedAt,omitempty"`
	// EventUpdatedAt: el `updated_at` del payload, para «hace cuánto» acabó.
	EventUpdatedAt *time.Time `json:"eventUpdatedAt,omitempty"`
}

const (
	RunStatusCompleted  = "completed"
	RunStatusInProgress = "in_progress"
)

// WorkflowRunRank es el orden de los estados que **no se deshace**.
//
// Los webhooks de GitHub no llegan ordenados: el `in_progress` puede entrar
// después del `completed` si una entrega se reintentó. Con un rango por estado,
// el upsert sólo escribe si lo que llega está igual o más adelante que lo
// guardado, y un `in_progress` tardío no vuelve a poner «en curso» un run que
// ya terminó. Un número y no el `updated_at` del payload porque dentro de un
// intento el estado es monótono, y un rango se prueba sin relojes.
//
// `requested`, `queued`, `waiting` y `pending` valen lo mismo: entre ellos el
// orden no importa, y uno que llegue después pisa al anterior sin daño.
func WorkflowRunRank(status string) int16 {
	switch status {
	case RunStatusCompleted:
		return 3
	case RunStatusInProgress:
		return 2
	default:
		return 1
	}
}

// IsRunTerminal: si un run ya no va a cambiar.
func IsRunTerminal(status string) bool { return status == RunStatusCompleted }

// ─── El feed ──────────────────────────────────────────────────────────────────

// ActivityFilter: qué parte de la actividad de la org se pide.
type ActivityFilter struct {
	// Repo: `owner/repo`, sin distinguir mayúsculas. Vacío = todos.
	Repo string
	// DeployableID: un servicio. Trae sus deploys y los runs de su repo que son
	// de su workflow de build (o todos los del repo si no tiene workflow puesto).
	DeployableID string
	// Limit: 1..ActivityPageMax; cero = ActivityPageDefault.
	Limit int
	// Before y BeforeID: el cursor, el `At` y el id de la última entrada que ya
	// se vio. Juntos y no sólo la fecha, porque dos entradas pueden caer en el
	// mismo instante y una paginación por fecha sola repetiría o saltaría una.
	Before   time.Time
	BeforeID string
}

const (
	ActivityPageDefault = 50
	ActivityPageMax     = 200

	ActivityKindRun        = "run"
	ActivityKindDeployment = "deployment"
)

// ActivityDeployment: un deploy tal como se enseña en la actividad, con el
// servicio al que pertenece, que la fila de `deployments` no lleva por nombre.
type ActivityDeployment struct {
	DeploymentSummary
	DeployableName string `json:"deployableName"`
	DeployableEnv  string `json:"deployableEnv"`
}

// ActivityEntry: una línea del feed. O es un run o es un deploy, nunca los dos;
// `Kind` dice cuál, y `At` es por lo que están ordenadas.
type ActivityEntry struct {
	Kind string       `json:"kind"`
	At   time.Time    `json:"at"`
	Run  *WorkflowRun `json:"run,omitempty"`
	// Deployments: los deploys que este run disparó (cero, uno, o varios si dos
	// servicios comparten repo y workflow). Sólo con Kind = run.
	Deployments []ActivityDeployment `json:"deployments,omitempty"`
	Deployment  *ActivityDeployment  `json:"deployment,omitempty"`
}

// ActivityPage: una página del feed. `HasMore` se sabe pidiendo una entrada de
// más, no contando: contar es otra consulta sobre dos tablas por cada página.
type ActivityPage struct {
	Items   []ActivityEntry `json:"items"`
	HasMore bool            `json:"hasMore"`
}
