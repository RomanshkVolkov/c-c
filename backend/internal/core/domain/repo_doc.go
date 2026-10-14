package domain

import (
	"path"
	"strings"
	"time"
)

// ─── Los .md de un repo, en Documentación (docs as code) ─────────────────────
//
// Cada repo atado a un espacio enseña en Documentación todos sus ficheros
// markdown, por carpetas, como hace Confluence con un repo. **Sólo lectura**:
// el repo es la fuente y se edita con una PR; aquí se guarda una copia para
// poder pintarla, buscarla y enlazarla sin pedirle nada a GitHub al abrirla.
//
// La copia se pone al día por árbol: con cada push a la rama por defecto se
// pide el árbol entero, y sólo se baja el blob cuyo sha cambió. Un sha es el
// contenido, así que un fichero con el mismo sha no hace falta ni mirarlo.

// RepoDoc: un fichero markdown de un repo, tal como estaba en su último push.
type RepoDoc struct {
	BaseModel
	OrgID string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// RepoID: el de GitHub (`GitHubRepo.RepoID`), que no cambia al renombrar
	// el repo.
	RepoID int64  `gorm:"not null;uniqueIndex:idx_repo_doc_path" json:"repoId"`
	Path   string `gorm:"type:varchar(1024);not null;uniqueIndex:idx_repo_doc_path" json:"path"`
	Title  string `gorm:"type:varchar(300);not null" json:"title"`
	// BlobSha: si no cambia, el fichero no se vuelve a bajar.
	BlobSha string `gorm:"type:varchar(64);not null" json:"blobSha"`
	Body    string `gorm:"type:text;not null;default:''" json:"body,omitempty"`
	// TooLarge: pasó de MaxDocBodyChars. Sin cuerpo; la pantalla enlaza a
	// GitHub en vez de pintar media página.
	TooLarge bool `gorm:"not null;default:false" json:"tooLarge"`
}

func (RepoDoc) TableName() string { return "repo_docs" }

// Estados de la copia de un repo (`GitHubRepo.DocsState`).
const (
	RepoDocsOK = "ok"
	// RepoDocsTruncated: GitHub cortó el árbol, o el repo tiene más de
	// MaxRepoDocs ficheros. Se guarda lo que cupo y **no se borra nada**: un
	// fichero que no vino puede seguir ahí.
	RepoDocsTruncated = "truncated"
	RepoDocsError     = "error"
)

// MaxRepoDocs: los ficheros que se copian de un repo. Un monorepo con miles
// de READMEs de dependencias no es documentación que alguien vaya a leer
// desde aquí.
const MaxRepoDocs = 1000

// skippedDirs: carpetas que no son la documentación del repo, sino la de lo
// que el repo trae dentro o construye.
var skippedDirs = map[string]bool{
	"node_modules": true, "vendor": true, "dist": true, "build": true, "target": true,
}

// IsRepoDocPath: si un fichero del árbol de un repo se enseña como doc.
//
// Fuera también cualquier carpeta que empiece por punto, `.github` incluida:
// las plantillas de issues y PRs son markdown, pero son formularios, no
// documentación.
func IsRepoDocPath(p string) bool {
	low := strings.ToLower(p)
	if !strings.HasSuffix(low, ".md") && !strings.HasSuffix(low, ".markdown") {
		return false
	}
	parts := strings.Split(p, "/")
	for _, dir := range parts[:len(parts)-1] {
		if dir == "" || strings.HasPrefix(dir, ".") || skippedDirs[strings.ToLower(dir)] {
			return false
		}
	}
	return true
}

// repoImageTypes: lo que se sirve como imagen de un repo, por extensión.
var repoImageTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
}

// RepoImagePath limpia la ruta de una imagen que pide un doc del repo y dice
// su tipo. Sólo imágenes y sólo dentro del repo: con un `..` o una extensión
// que no es de imagen, nada. Es la puerta que impide usar la ruta para leer
// cualquier fichero del repo —un `.env`, una llave— con el token de la App.
func RepoImagePath(raw string) (string, string, bool) {
	if raw == "" || strings.Contains(raw, "\\") || strings.Contains(raw, "\x00") {
		return "", "", false
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == ".." {
			return "", "", false
		}
	}
	clean := strings.TrimPrefix(path.Clean("/"+raw), "/")
	ct, ok := repoImageTypes[strings.ToLower(path.Ext(clean))]
	if !ok || clean == "" {
		return "", "", false
	}
	return clean, ct, true
}

// RepoDocTitle: el primer título de nivel 1 del fichero, fuera de los
// bloques de código (un `# comentario` de un bloque de shell no es el
// título). Sin ninguno, el nombre del fichero sin extensión.
func RepoDocTitle(p, body string) string {
	fence := ""
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(t, fence) {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			fence = t[:3]
			continue
		}
		if title, ok := strings.CutPrefix(t, "# "); ok {
			if title = strings.TrimSpace(strings.TrimRight(title, "#")); title != "" {
				return clipRunes(title, 300)
			}
		}
	}
	name := path.Base(p)
	return strings.TrimSuffix(name, path.Ext(name))
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// RepoBlobURL: dónde se ve el fichero en GitHub.
func RepoBlobURL(fullName, branch, p string) string {
	return "https://github.com/" + fullName + "/blob/" + branch + "/" + p
}

// RepoDocsGroup: los docs de un repo, como los pide el panel. Sin cuerpo.
type RepoDocsGroup struct {
	RepoID   int64          `json:"repoId"`
	FullName string         `json:"fullName"`
	Branch   string         `json:"branch"`
	State    string         `json:"state"`
	SyncedAt *time.Time     `json:"syncedAt"`
	Files    []RepoDocEntry `json:"files"`
}

type RepoDocEntry struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Title string `json:"title"`
}

// RepoDocResponse: un doc del repo con lo que hace falta para pintarlo.
type RepoDocResponse struct {
	RepoDoc
	FullName string     `json:"fullName"`
	Branch   string     `json:"branch"`
	SpaceID  string     `json:"spaceId"`
	HTMLURL  string     `json:"htmlUrl"`
	SyncedAt *time.Time `json:"syncedAt"`
}
