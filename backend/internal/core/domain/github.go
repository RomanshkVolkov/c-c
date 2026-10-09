package domain

import "time"

// ─── GitHub App ───────────────────────────────────────────────────────────────
//
// Una sola App de GitHub para todas las orgs de cac. Cada instalación (en una
// cuenta u organización de GitHub) se ata a **una** org de cac, y de ella
// cuelgan sus repos. Un repo se enlaza a un espacio, y desde ahí sus commits y
// PRs que nombran una tarea dejan una línea en ella.
//
// Lo que llega de GitHub sólo **comenta**: nunca crea, mueve ni cierra nada. Una
// referencia que no resuelve se descarta.

// GitHubInstallation: una instalación de la App. OrgID vacío = todavía no se
// ha atado a ninguna org (el webhook puede llegar antes que la vuelta del
// navegador, o al revés).
type GitHubInstallation struct {
	BaseModel
	InstallationID int64  `gorm:"uniqueIndex;not null"            json:"installationId"`
	AccountLogin   string `gorm:"type:varchar(120)"               json:"accountLogin"`
	OrgID          string `gorm:"type:varchar(36);index"          json:"orgId"`
}

// GitHubRepo: un repo al que la instalación da acceso. SpaceID vacío = no
// enlazado: sus commits no comentan nada.
type GitHubRepo struct {
	BaseModel
	InstallationID int64  `gorm:"index;not null"                  json:"installationId"`
	RepoID         int64  `gorm:"uniqueIndex;not null"            json:"repoId"`
	FullName       string `gorm:"type:varchar(200);not null"      json:"fullName"`
	OrgID          string `gorm:"type:varchar(36);index"          json:"orgId"`
	SpaceID        string `gorm:"type:varchar(36);index"          json:"spaceId"`
	// BareRefs: si `#12` a secas nombra la tarea 12 del espacio. Apagado por
	// defecto porque en GitHub `#12` es el issue o la PR 12 del repo, y casi
	// todo commit que lo escribe habla de eso.
	BareRefs bool `gorm:"not null;default:false" json:"bareRefs"`
}

type GitHubStatusResponse struct {
	// Configured: si este servidor tiene la App puesta. Sin ella, todo lo de
	// GitHub contesta 503 y la app lo dice en vez de enseñar un botón muerto.
	Configured    bool                 `json:"configured"`
	Installations []GitHubInstallation `json:"installations"`
	Repos         []GitHubRepo         `json:"repos"`
}

type GitHubLinkResponse struct {
	URL string `json:"url"`
}

type UpdateGitHubRepoRequest struct {
	SpaceID  string `json:"spaceId"  validate:"max=36"`
	BareRefs bool   `json:"bareRefs"`
}

// ─── Lo que GitHub tiene enlazado a una tarea ────────────────────────────────

// TaskGitLink: una rama, PR o commit de GitHub enlazado a una tarea.
//
// Hasta ahora lo único que quedaba era una línea en el hilo, y la tarea no sabía
// qué PRs tenía ni en qué estado estaban. Esto es lo que pinta el panel
// «Desarrollo» de la tarea, a la manera del de Jira: ramas, PRs con su estado y
// commits.
//
// Sigue valiendo la regla de la casa: lo que llega de GitHub **no mueve la
// tarea** ni la cierra; sólo se apunta.
type TaskGitLink struct {
	BaseModel
	OrgID        string `gorm:"type:varchar(36);index;not null" json:"-"`
	ItemID       string `gorm:"type:varchar(36);not null;uniqueIndex:idx_task_git_links_key,priority:1" json:"itemId"`
	RepoID       int64  `gorm:"not null;uniqueIndex:idx_task_git_links_key,priority:2;index:idx_task_git_links_ref,priority:1" json:"repoId"`
	RepoFullName string `gorm:"type:varchar(200);not null" json:"repoFullName"`
	// Kind: branch | pr | commit.
	Kind string `gorm:"type:varchar(10);not null;uniqueIndex:idx_task_git_links_key,priority:3;index:idx_task_git_links_ref,priority:2" json:"kind"`
	// Key: el nombre de la rama, el número de la PR o el sha del commit.
	Key         string `gorm:"type:varchar(300);not null;uniqueIndex:idx_task_git_links_key,priority:4;index:idx_task_git_links_ref,priority:3" json:"key"`
	Title       string `gorm:"type:varchar(300)" json:"title"`
	HTMLURL     string `gorm:"column:html_url;type:varchar(400)" json:"htmlUrl"`
	AuthorLogin string `gorm:"type:varchar(120)" json:"authorLogin"`
	// State: en una PR, open | draft | merged | closed; en una rama, active |
	// deleted; en un commit, vacío.
	State      string `gorm:"type:varchar(10)" json:"state"`
	HeadBranch string `gorm:"type:varchar(300)" json:"headBranch,omitempty"`
	BaseBranch string `gorm:"type:varchar(300)" json:"baseBranch,omitempty"`
	HeadSha    string `gorm:"type:varchar(40)" json:"headSha,omitempty"`
	// Via: cómo se enlazó — `text` (la tarea nombrada en el mensaje, el título o
	// el cuerpo) o `branch` (por el nombre de la rama). La pantalla lo dice.
	Via      string     `gorm:"type:varchar(10)" json:"via"`
	MergedAt *time.Time `json:"mergedAt,omitempty"`
	// GitHubUpdatedAt: el `updated_at` de la PR en GitHub. Es la guarda contra
	// las entregas tardías: GitHub no garantiza el orden, y una `synchronize`
	// vieja que llegara después del merge devolvería la PR a «abierta».
	GitHubUpdatedAt *time.Time `gorm:"column:github_updated_at" json:"-"`
	// OccurredAt ordena el panel: la fecha del commit, la de la PR, o la primera
	// vez que se vio la rama.
	OccurredAt time.Time `gorm:"index;not null" json:"occurredAt"`
}

func (TaskGitLink) TableName() string { return "task_git_links" }

const (
	GitLinkBranch = "branch"
	GitLinkPR     = "pr"
	GitLinkCommit = "commit"

	PRStateOpen   = "open"
	PRStateDraft  = "draft"
	PRStateMerged = "merged"
	PRStateClosed = "closed"

	BranchActive  = "active"
	BranchDeleted = "deleted"

	GitViaText   = "text"
	GitViaBranch = "branch"
	// GitViaManual: alguien pegó la URL de la PR en la tarea. Para la PR que
	// no nombra la tarea ni sale de una rama con su número (el caso que cubre
	// Linear con «Link pull request»).
	GitViaManual = "manual"
)

// PRStateOf: el estado de una PR tal como lo pinta cac.
//
// GitHub dice `closed` también de una PR fusionada (con `merged: true`), y
// `open` también de un borrador (con `draft: true`). Para quien mira la tarea
// son cuatro cosas distintas, así que se separan aquí, una vez.
func PRStateOf(state string, draft, merged bool) string {
	switch {
	case merged:
		return PRStateMerged
	case state == "closed":
		return PRStateClosed
	case draft:
		return PRStateDraft
	default:
		return PRStateOpen
	}
}

// GitSummary es lo que lleva una tarjeta del tablero: cuántas y en qué estado.
type GitSummary struct {
	Branches int `json:"branches"`
	PRs      int `json:"prs"`
	Commits  int `json:"commits"`
	// PRBadge: el estado que resume las PRs, con la precedencia de Jira.
	PRBadge string `json:"prBadge,omitempty"`
}

// GitBadge: el estado que resume varias PRs, como el panel de Jira.
//
// Abierta si hay alguna abierta (un borrador cuenta como abierta: hay trabajo
// en marcha); si no, fusionada si hay alguna fusionada; si no, cerrada. Sin
// PRs, vacío.
func GitBadge(open, merged, closed int) string {
	switch {
	case open > 0:
		return PRStateOpen
	case merged > 0:
		return PRStateMerged
	case closed > 0:
		return PRStateClosed
	default:
		return ""
	}
}

// TaskGitLinks: todo lo enlazado a una tarea, agrupado como lo pinta el panel.
type TaskGitLinks struct {
	Summary  GitSummary    `json:"summary"`
	Branches []TaskGitLink `json:"branches"`
	PRs      []TaskGitLink `json:"prs"`
	Commits  []TaskGitLink `json:"commits"`
}

// MaxGitCommitsShown: cuántos commits se devuelven por tarea, como Jira (100).
// El resumen sí los cuenta todos.
const MaxGitCommitsShown = 100

// LinkPRRequest: la URL de una PR, pegada en una tarea.
type LinkPRRequest struct {
	URL string `json:"url" validate:"required,max=500"`
}
