package repository

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// ─── La copia de los .md de un repo (ver domain/repo_doc.go) ─────────────────

// RepoDocShas: lo guardado de un repo, ruta → sha. Es con lo que se compara
// un árbol nuevo para saber qué bajar.
func (r *GitHubRepository) RepoDocShas(repoID int64) (map[string]string, error) {
	var rows []domain.RepoDoc
	if err := r.db.Select("path", "blob_sha").Where("repo_id = ?", repoID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, d := range rows {
		out[d.Path] = d.BlobSha
	}
	return out, nil
}

// RepoDocsSync: lo que salió de comparar un árbol, en una transacción. Si
// algo falla, la copia se queda como estaba y con su árbol viejo, así que el
// siguiente push lo vuelve a intentar entero.
type RepoDocsSync struct {
	Upserts []domain.RepoDoc
	Deletes []string
	Branch  string
	TreeSha string
	State   string
	At      time.Time
}

func (r *GitHubRepository) ApplyRepoDocs(repoID int64, s RepoDocsSync) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for i := range s.Upserts {
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "repo_id"}, {Name: "path"}},
				DoUpdates: clause.AssignmentColumns([]string{"org_id", "title", "blob_sha", "body", "too_large", "updated_at"}),
			}).Create(&s.Upserts[i]).Error; err != nil {
				return err
			}
		}
		if len(s.Deletes) > 0 {
			if err := tx.Where("repo_id = ? AND path IN ?", repoID, s.Deletes).Delete(&domain.RepoDoc{}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&domain.GitHubRepo{}).Where("repo_id = ?", repoID).Updates(map[string]any{
			"docs_branch": s.Branch, "docs_tree_sha": s.TreeSha, "docs_state": s.State, "docs_synced_at": s.At,
		}).Error
	})
}

// MarkRepoDocs apunta un estado sin tocar la copia: un fallo de GitHub no
// borra lo que ya se tenía.
func (r *GitHubRepository) MarkRepoDocs(repoID int64, state string) error {
	return r.db.Model(&domain.GitHubRepo{}).Where("repo_id = ?", repoID).Update("docs_state", state).Error
}

// SetDocsBranch: la rama por defecto, cuando se averigua. Cambiarla deja el
// árbol sin saber, para que la siguiente vez se compare entero.
func (r *GitHubRepository) SetDocsBranch(repoID int64, branch string) error {
	return r.db.Model(&domain.GitHubRepo{}).Where("repo_id = ?", repoID).
		Updates(map[string]any{"docs_branch": branch, "docs_tree_sha": ""}).Error
}

// DropRepoDocs borra la copia de un repo y olvida su árbol: al volver a
// encenderlo se baja entero.
func (r *GitHubRepository) DropRepoDocs(repoID int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("repo_id = ?", repoID).Delete(&domain.RepoDoc{}).Error; err != nil {
			return err
		}
		return tx.Model(&domain.GitHubRepo{}).Where("repo_id = ?", repoID).
			Updates(map[string]any{"docs_tree_sha": "", "docs_state": "", "docs_synced_at": nil}).Error
	})
}

// RepoDocsForSpace: los repos de un espacio que enseñan sus docs, cada uno
// con sus ficheros sin cuerpo, ordenados por ruta.
func (r *GitHubRepository) RepoDocsForSpace(orgID, spaceID string) ([]domain.RepoDocsGroup, error) {
	var repos []domain.GitHubRepo
	if err := r.db.Where("org_id = ? AND space_id = ? AND show_docs", orgID, spaceID).
		Order("full_name").Find(&repos).Error; err != nil {
		return nil, err
	}
	out := make([]domain.RepoDocsGroup, 0, len(repos))
	for _, repo := range repos {
		files := []domain.RepoDocEntry{}
		if err := r.db.Model(&domain.RepoDoc{}).Select("id", "path", "title").
			Where("repo_id = ? AND org_id = ?", repo.RepoID, orgID).Order("path").Scan(&files).Error; err != nil {
			return nil, err
		}
		out = append(out, domain.RepoDocsGroup{
			RepoID: repo.RepoID, FullName: repo.FullName, Branch: repo.DocsBranch,
			State: repo.DocsState, SyncedAt: repo.DocsSyncedAt, Files: files,
		})
	}
	return out, nil
}

// FindRepoDoc: un doc con su repo. Quién puede verlo lo decide el handler con
// la org que trae.
func (r *GitHubRepository) FindRepoDoc(id string) (*domain.RepoDoc, *domain.GitHubRepo, error) {
	var d domain.RepoDoc
	if err := r.db.First(&d, "id = ?", id).Error; err != nil {
		return nil, nil, err
	}
	repo, err := r.FindRepo(d.RepoID)
	if err != nil {
		return nil, nil, err
	}
	return &d, repo, nil
}

// SpaceOrg: la org de un espacio vivo.
func (r *GitHubRepository) SpaceOrg(spaceID string) (string, error) {
	var sp domain.TaskSpace
	if err := r.db.Select("org_id").First(&sp, "id = ?", spaceID).Error; err != nil {
		return "", err
	}
	return sp.OrgID, nil
}

// FindRepoDocByPath: un doc por su ruta en el repo.
func (r *GitHubRepository) FindRepoDocByPath(repoID int64, path string) (*domain.RepoDoc, error) {
	var d domain.RepoDoc
	if err := r.db.First(&d, "repo_id = ? AND path = ?", repoID, path).Error; err != nil {
		return nil, err
	}
	return &d, nil
}
