package domain

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
