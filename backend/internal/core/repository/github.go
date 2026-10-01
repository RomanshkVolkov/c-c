package repository

import (
	"errors"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// ErrInstallationTaken: la instalación ya está atada a otra org.
var ErrInstallationTaken = errors.New("github installation already linked to another org")

type GitHubRepository struct{ db *gorm.DB }

func NewGitHubRepository(db *gorm.DB) *GitHubRepository { return &GitHubRepository{db: db} }

// EnsureGitHubIndexes: una línea de fuera, una sola vez por tarea. Aquí para
// que las pruebas monten el mismo índice que producción.
func EnsureGitHubIndexes(db *gorm.DB) error {
	return db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_item_comments_source
		ON item_comments (item_id, source_key) WHERE source_key <> ''`).Error
}

// ─── Instalaciones ────────────────────────────────────────────────────────────

// UpsertInstallation guarda lo que cuenta el webhook, sin tocar a qué org está
// atada: eso sólo lo decide la vuelta del navegador con su `state`.
func (r *GitHubRepository) UpsertInstallation(id int64, account string) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "installation_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"account_login", "updated_at"}),
	}).Create(&domain.GitHubInstallation{InstallationID: id, AccountLogin: account}).Error
}

// BindInstallation ata una instalación a una org. La primera que la ata se la
// queda: atarla a otra org es ErrInstallationTaken, nunca una reasignación.
func (r *GitHubRepository) BindInstallation(id int64, orgID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).
			Create(&domain.GitHubInstallation{InstallationID: id}).Error; err != nil {
			return err
		}
		res := tx.Model(&domain.GitHubInstallation{}).
			Where("installation_id = ? AND (org_id = '' OR org_id IS NULL OR org_id = ?)", id, orgID).
			Update("org_id", orgID)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrInstallationTaken
		}
		// Los repos que llegaron antes de atarla, a la misma org.
		return tx.Model(&domain.GitHubRepo{}).Where("installation_id = ?", id).Update("org_id", orgID).Error
	})
}

func (r *GitHubRepository) DeleteInstallation(id int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("installation_id = ?", id).Delete(&domain.GitHubRepo{}).Error; err != nil {
			return err
		}
		return tx.Where("installation_id = ?", id).Delete(&domain.GitHubInstallation{}).Error
	})
}

func (r *GitHubRepository) installationOrg(id int64) string {
	var inst domain.GitHubInstallation
	if r.db.First(&inst, "installation_id = ?", id).Error != nil {
		return ""
	}
	return inst.OrgID
}

// ─── Repos ────────────────────────────────────────────────────────────────────

// UpsertRepo guarda un repo de una instalación, con la org de ésta. Enlazarlo
// a un espacio no se toca: eso lo decide alguien de la org.
func (r *GitHubRepository) UpsertRepo(installationID, repoID int64, fullName string) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "repo_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"full_name", "installation_id", "org_id", "updated_at"}),
	}).Create(&domain.GitHubRepo{
		InstallationID: installationID, RepoID: repoID, FullName: fullName,
		OrgID: r.installationOrg(installationID),
	}).Error
}

func (r *GitHubRepository) DeleteRepo(repoID int64) error {
	return r.db.Where("repo_id = ?", repoID).Delete(&domain.GitHubRepo{}).Error
}

func (r *GitHubRepository) FindRepo(repoID int64) (*domain.GitHubRepo, error) {
	var repo domain.GitHubRepo
	if err := r.db.First(&repo, "repo_id = ?", repoID).Error; err != nil {
		return nil, err
	}
	return &repo, nil
}

func (r *GitHubRepository) FindRepoInOrg(orgID, id string) (*domain.GitHubRepo, error) {
	var repo domain.GitHubRepo
	if err := r.db.First(&repo, "id = ? AND org_id = ?", id, orgID).Error; err != nil {
		return nil, err
	}
	return &repo, nil
}

func (r *GitHubRepository) LinkRepo(id, spaceID string, bare bool) error {
	return r.db.Model(&domain.GitHubRepo{}).Where("id = ?", id).
		Updates(map[string]any{"space_id": spaceID, "bare_refs": bare}).Error
}

func (r *GitHubRepository) ListForOrg(orgID string) ([]domain.GitHubInstallation, []domain.GitHubRepo, error) {
	insts := []domain.GitHubInstallation{}
	repos := []domain.GitHubRepo{}
	if err := r.db.Where("org_id = ?", orgID).Order("account_login").Find(&insts).Error; err != nil {
		return nil, nil, err
	}
	err := r.db.Where("org_id = ?", orgID).Order("full_name").Find(&repos).Error
	return insts, repos, err
}

// SpaceInOrg: si el espacio es de esa org. Un repo no se enlaza a un espacio
// de otra.
func (r *GitHubRepository) SpaceInOrg(spaceID, orgID string) bool {
	var n int64
	r.db.Model(&domain.TaskSpace{}).Where("id = ? AND org_id = ?", spaceID, orgID).Count(&n)
	return n == 1
}

// ─── Resolver una referencia ──────────────────────────────────────────────────

// FindRefTarget: la tarea que nombra una referencia, **sólo dentro de la org**.
// Un número del espacio es una tarea interna (sin proyecto); un folio es del
// proyecto con ese slug. La org la pone la tarea: una tarea de un proyecto
// lleva la org de ese proyecto.
func (r *GitHubRepository) FindRefTarget(orgID, spaceID string, ref domain.TaskRef) (*domain.Item, error) {
	var it domain.Item
	q := r.db.Where("items.org_id = ? AND items.seq = ?", orgID, ref.Seq)
	if ref.Slug == "" {
		q = q.Where("items.space_id = ? AND items.project_id = ''", spaceID)
	} else {
		q = q.Joins("JOIN report_projects p ON p.id = items.project_id").
			Where("p.slug = ?", ref.Slug)
	}
	if err := q.First(&it).Error; err != nil {
		return nil, err
	}
	return &it, nil
}

// AddSourcedComment escribe una línea de fuera una sola vez por tarea y
// procedencia. Dice si la escribió (false = ya estaba).
func (r *GitHubRepository) AddSourcedComment(c *domain.ItemComment) (bool, error) {
	res := r.db.Clauses(clause.OnConflict{
		Columns:     []clause.Column{{Name: "item_id"}, {Name: "source_key"}},
		TargetWhere: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "source_key <> ''"}}},
		DoNothing:   true,
	}).Create(c)
	return res.RowsAffected == 1, res.Error
}

// FindRepoByName: el repo de la org con ese `owner/name`, sin distinguir
// mayúsculas (GitHub no las distingue).
func (r *GitHubRepository) FindRepoByName(orgID, fullName string) (*domain.GitHubRepo, error) {
	var repo domain.GitHubRepo
	if err := r.db.First(&repo, "org_id = ? AND LOWER(full_name) = LOWER(?)", orgID, fullName).Error; err != nil {
		return nil, err
	}
	return &repo, nil
}
