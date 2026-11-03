package domain

import "time"

// Release: una release publicada en GitHub de un repo de la org, con los
// commits que lleva (los de entre la anterior y ésta).
//
// Es lo que deja a cac contestar «¿esto ya salió?» sin que nadie se acuerde
// de mirarlo: hasta el 2-nov-2026, una tarea commiteada y sin release se
// quedaba «en curso» hasta que una sesión volvía a comprobarlo con
// `git tag --contains`, y un incidente «abierto hasta la release» igual
// (command-and-control-295).
//
// **Marca y avisa; no mueve ni cierra nada** (decidido con jose el
// 2-nov-2026). Sigue la regla de la casa de `TaskGitLink`: lo que llega de
// GitHub sólo se apunta. Cada commit sabe en qué release salió
// (`TaskGitLink.ReleasedIn`), una tarea en curso o un incidente con todo
// publicado lo dice (`Shipped`), y quien la cierra es la sesión o la persona.
//
// Nada de esto se escribe en `task_git_links` ni en `incident_commits`: se
// calcula al leer, cruzando por (repo, sha). Así una release borrada o vuelta
// a cortar no deja nada colgado.
type Release struct {
	BaseModel
	OrgID        string    `gorm:"type:varchar(36);index;not null" json:"orgId"`
	RepoID       int64     `gorm:"not null;uniqueIndex:idx_releases_tag,priority:1" json:"repoId"`
	RepoFullName string    `gorm:"type:varchar(200);not null" json:"repoFullName"`
	Tag          string    `gorm:"type:varchar(120);not null;uniqueIndex:idx_releases_tag,priority:2" json:"tag"`
	Name         string    `gorm:"type:varchar(300)" json:"name"`
	HTMLURL      string    `gorm:"column:html_url;type:varchar(400)" json:"htmlUrl"`
	AuthorLogin  string    `gorm:"type:varchar(120)" json:"authorLogin"`
	PublishedAt  time.Time `gorm:"index;not null" json:"publishedAt"`
	// PrevTag: la release contra la que se compararon los commits. Vacía en la
	// primera de un repo: sin base no se sabe qué trae, y no se inventa.
	PrevTag     string `gorm:"type:varchar(120)" json:"prevTag"`
	CommitCount int    `json:"commitCount"`
	// Truncated: trae más commits de los que se leen (MaxReleaseCommits).
	Truncated bool `json:"truncated"`
}

func (Release) TableName() string { return "releases" }

// ReleaseCommit: un commit que salió en una release. Único por (repo, sha):
// un commit sale una vez, en la primera release que lo trae.
type ReleaseCommit struct {
	ID        string    `gorm:"primaryKey;type:varchar(36)" json:"id"`
	ReleaseID string    `gorm:"type:varchar(36);index;not null" json:"releaseId"`
	RepoID    int64     `gorm:"not null;uniqueIndex:idx_release_commits_sha,priority:1" json:"repoId"`
	SHA       string    `gorm:"column:sha;type:varchar(40);not null;uniqueIndex:idx_release_commits_sha,priority:2" json:"sha"`
	Title     string    `gorm:"type:varchar(200)" json:"title"`
	HTMLURL   string    `gorm:"column:html_url;type:varchar(400)" json:"htmlUrl"`
	CreatedAt time.Time `json:"createdAt"`
}

func (ReleaseCommit) TableName() string { return "release_commits" }

// ReleaseRef: en qué release salió algo. Es lo que viaja como `releasedIn`
// (un commit) y como `shipped` (una tarea o un incidente).
type ReleaseRef struct {
	Tag string    `json:"tag"`
	At  time.Time `json:"at"`
	URL string    `json:"url,omitempty"`
}

// MaxReleaseCommits: cuántos commits de una release se leen (una página de
// `compare`). Una release de la app sale por feature (scripts/next-version.sh)
// y no llega; si llegara, la release lo dice (`Truncated`).
const MaxReleaseCommits = 250

// ShippedOf: si algo con `total` commits enlazados ya salió entero, y en qué
// release. Nil si no tiene commits (nada que haya podido salir) o si alguno
// no salió todavía; si salieron todos, la release más reciente de ellos, que
// es cuando quedó entero fuera.
//
// Es la definición de «salió» en un solo sitio: la usan las tareas del mapa y
// los incidentes. Una tarea con un commit del backend (que se despliega con el
// push, sin release) no sale nunca por aquí: para ésas manda el handoff.
func ShippedOf(total int, released []ReleaseRef) *ReleaseRef {
	if total == 0 || len(released) < total {
		return nil
	}
	latest := released[0]
	for _, r := range released[1:] {
		if r.At.After(latest.At) {
			latest = r
		}
	}
	return &latest
}
