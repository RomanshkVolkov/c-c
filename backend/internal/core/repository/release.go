package repository

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Releases de GitHub y sus commits (ver domain.Release): se guardan al
// publicarse y se cruzan al leer con los commits de las tareas y de los
// incidentes. Nada de aquí escribe en esas tablas.

// EnsureReleaseIndexes: el sha de un incidente puede ser corto (7 a 40), así
// que se busca por prefijo; con `varchar_pattern_ops` el `LIKE 'abc1234%'`
// usa el índice aunque la base no esté en colación C.
func EnsureReleaseIndexes(db *gorm.DB) error {
	return db.Exec(`CREATE INDEX IF NOT EXISTS idx_release_commits_sha_prefix
		ON release_commits (sha varchar_pattern_ops)`).Error
}

// FindRelease: la release de ese repo con ese tag; nil si no está.
func (r *GitHubRepository) FindRelease(repoID int64, tag string) (*domain.Release, error) {
	var rel domain.Release
	err := r.db.Where("repo_id = ? AND tag = ?", repoID, tag).First(&rel).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &rel, err
}

// PreviousRelease: la última release del repo publicada antes de `before`.
func (r *GitHubRepository) PreviousRelease(repoID int64, before time.Time) (*domain.Release, error) {
	var rel domain.Release
	err := r.db.Where("repo_id = ? AND published_at < ?", repoID, before).
		Order("published_at DESC").First(&rel).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &rel, err
}

// SaveRelease guarda la release y sus commits de una vez. Si ya estaba (una
// reentrega que corre a la vez que otra), no escribe nada y lo dice.
//
// Un commit que ya salió en otra release no se mueve: sale en la primera que
// lo trajo (índice único por repo y sha).
func (r *GitHubRepository) SaveRelease(rel *domain.Release, commits []domain.ReleaseCommit) (bool, error) {
	created := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "repo_id"}, {Name: "tag"}},
			DoNothing: true,
		}).Create(rel)
		if res.Error != nil || res.RowsAffected == 0 {
			return res.Error
		}
		created = true
		for i := range commits {
			commits[i].ID = uuid.NewString()
			commits[i].ReleaseID = rel.ID
			commits[i].RepoID = rel.RepoID
		}
		if len(commits) == 0 {
			return nil
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "repo_id"}, {Name: "sha"}},
			DoNothing: true,
		}).CreateInBatches(commits, 100).Error
	})
	return created, err
}

// UpdateReleaseMeta: una release editada en GitHub (su nombre o su enlace).
func (r *GitHubRepository) UpdateReleaseMeta(repoID int64, tag, name, url string) error {
	return r.db.Model(&domain.Release{}).Where("repo_id = ? AND tag = ?", repoID, tag).
		Updates(map[string]any{"name": name, "html_url": url, "updated_at": time.Now()}).Error
}

// DeleteRelease: una release borrada o despublicada deja de contar, con sus
// commits. Lo que se escribió en los hilos se queda: es historia.
func (r *GitHubRepository) DeleteRelease(repoID int64, tag string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var rel domain.Release
		if err := tx.Where("repo_id = ? AND tag = ?", repoID, tag).First(&rel).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if err := tx.Where("release_id = ?", rel.ID).Delete(&domain.ReleaseCommit{}).Error; err != nil {
			return err
		}
		return tx.Delete(&rel).Error
	})
}

// ReleaseCommitsOf: los shas de una release, para volver a comentar en una
// reentrega sin preguntarle nada a GitHub.
func (r *GitHubRepository) ReleaseCommitsOf(releaseID string) ([]string, error) {
	var shas []string
	err := r.db.Model(&domain.ReleaseCommit{}).Where("release_id = ?", releaseID).Pluck("sha", &shas).Error
	return shas, err
}

// TaskCommits: las tareas que tienen enlazados algunos de esos commits del
// repo, con cuántos de ellos cada una.
type TaskCommits struct {
	Item  domain.Item
	Count int
}

// TasksOfCommits: ver TaskCommits. Las archivadas y borradas no: no hay a
// quién avisar.
func (r *GitHubRepository) TasksOfCommits(repoID int64, shas []string) ([]TaskCommits, error) {
	if len(shas) == 0 {
		return nil, nil
	}
	type row struct {
		ItemID string
		N      int
	}
	var rows []row
	if err := r.db.Model(&domain.TaskGitLink{}).Select("item_id, count(*) AS n").
		Where("repo_id = ? AND kind = ? AND key IN ?", repoID, domain.GitLinkCommit, shas).
		Group("item_id").Order("item_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	var out []TaskCommits
	for _, x := range rows {
		var it domain.Item
		if err := r.db.Where("id = ? AND archived_at IS NULL AND deleted_at IS NULL", x.ItemID).First(&it).Error; err != nil {
			continue
		}
		out = append(out, TaskCommits{Item: it, Count: x.N})
	}
	return out, nil
}

// hasReleases: una base sin las tablas de releases (una de pruebas que no las
// migra) contesta «nada salió» en vez de caerse. `GitLinksOf` lo necesita: el
// detalle de una tarea no puede caerse por esto, y
// `handler.TestTheGitHubLinksOfATaskAreFenced` migra sólo tareas y enlaces.
func hasReleases(db *gorm.DB) bool {
	return db.Migrator().HasTable(&domain.Release{}) && db.Migrator().HasTable(&domain.ReleaseCommit{})
}

// ReleasesOfCommits: en qué release salió cada uno de esos commits del repo.
// Los que no salieron no están en el mapa.
func ReleasesOfCommits(db *gorm.DB, repoID int64, shas []string) (map[string]domain.ReleaseRef, error) {
	out := map[string]domain.ReleaseRef{}
	if len(shas) == 0 || !hasReleases(db) {
		return out, nil
	}
	type row struct {
		SHA         string `gorm:"column:sha"`
		Tag         string
		PublishedAt time.Time
		HTMLURL     string `gorm:"column:html_url"`
	}
	var rows []row
	if err := db.Table("release_commits rc").
		Select("rc.sha, r.tag, r.published_at, r.html_url").
		Joins("JOIN releases r ON r.id = rc.release_id").
		Where("rc.repo_id = ? AND rc.sha IN ?", repoID, shas).Scan(&rows).Error; err != nil {
		return out, err
	}
	for _, x := range rows {
		out[x.SHA] = domain.ReleaseRef{Tag: x.Tag, At: x.PublishedAt, URL: x.HTMLURL}
	}
	return out, nil
}

// releasedRow: un commit enlazado de algo (una tarea, un incidente) y, si
// salió, en qué release. Tag vacío: no salió.
type releasedRow struct {
	OwnerID     string
	Tag         string
	PublishedAt *time.Time
	HTMLURL     string `gorm:"column:html_url"`
}

// shippedFrom agrega las filas por dueño con domain.ShippedOf.
func shippedFrom(rows []releasedRow) map[string]*domain.ReleaseRef {
	total := map[string]int{}
	released := map[string][]domain.ReleaseRef{}
	for _, x := range rows {
		total[x.OwnerID]++
		if x.Tag != "" && x.PublishedAt != nil {
			released[x.OwnerID] = append(released[x.OwnerID], domain.ReleaseRef{Tag: x.Tag, At: *x.PublishedAt, URL: x.HTMLURL})
		}
	}
	out := map[string]*domain.ReleaseRef{}
	for id, n := range total {
		if s := domain.ShippedOf(n, released[id]); s != nil {
			out[id] = s
		}
	}
	return out
}

// ShippedOfTasks: de esas tareas, las que tienen todos sus commits enlazados
// ya publicados, y en qué release (ver domain.ShippedOf).
func (r *GitHubRepository) ShippedOfTasks(itemIDs []string) (map[string]*domain.ReleaseRef, error) {
	return shippedOfTasks(r.db, itemIDs)
}

func shippedOfTasks(db *gorm.DB, itemIDs []string) (map[string]*domain.ReleaseRef, error) {
	if len(itemIDs) == 0 || !hasReleases(db) || !db.Migrator().HasTable(&domain.TaskGitLink{}) {
		return map[string]*domain.ReleaseRef{}, nil
	}
	var rows []releasedRow
	err := db.Table("task_git_links l").
		Select("l.item_id AS owner_id, coalesce(r.tag, '') AS tag, r.published_at, coalesce(r.html_url, '') AS html_url").
		Joins("LEFT JOIN release_commits rc ON rc.repo_id = l.repo_id AND rc.sha = l.key").
		Joins("LEFT JOIN releases r ON r.id = rc.release_id").
		Where("l.kind = ? AND l.item_id IN ?", domain.GitLinkCommit, itemIDs).Scan(&rows).Error
	if err != nil {
		return map[string]*domain.ReleaseRef{}, err
	}
	return shippedFrom(rows), nil
}

// ShippedOfIncidents: lo mismo para incidentes. Su sha puede ser corto y su
// repo puede faltar (`domain.ParseCommitRef`): se cruza por prefijo, y por
// repo sólo cuando lo dice. Un sha corto que casara con dos commits de
// releases distintas cuenta una vez, con la más reciente.
func ShippedOfIncidents(db *gorm.DB, incidentIDs []string) (map[string]*domain.ReleaseRef, error) {
	if len(incidentIDs) == 0 || !hasReleases(db) || !db.Migrator().HasTable(&domain.IncidentCommit{}) {
		return map[string]*domain.ReleaseRef{}, nil
	}
	var rows []releasedRow
	err := db.Raw(`
		SELECT ic.incident_id AS owner_id, coalesce(x.tag, '') AS tag, x.published_at, coalesce(x.html_url, '') AS html_url
		FROM incident_commits ic
		LEFT JOIN LATERAL (
			SELECT r.tag, r.published_at, r.html_url
			FROM release_commits rc JOIN releases r ON r.id = rc.release_id
			WHERE (rc.sha = ic.sha OR (length(ic.sha) < 40 AND rc.sha LIKE ic.sha || '%'))
			  AND (ic.repo = '' OR r.repo_full_name = ic.repo)
			ORDER BY r.published_at DESC LIMIT 1
		) x ON true
		WHERE ic.incident_id IN ?`, incidentIDs).Scan(&rows).Error
	if err != nil {
		return map[string]*domain.ReleaseRef{}, err
	}
	return shippedFrom(rows), nil
}
