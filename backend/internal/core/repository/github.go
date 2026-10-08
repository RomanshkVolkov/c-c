package repository

import (
	"errors"
	"time"

	"github.com/google/uuid"

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

// ─── Enlaces de GitHub en una tarea ──────────────────────────────────────────

// UpsertGitLink apunta o actualiza un enlace. Dice si cambió algo, para no
// avisar a la pantalla de una entrega que no aportó nada.
//
// La guarda es `github_updated_at`, como el rango de estado de los runs
// (`UpsertRun`) pero por tiempo: GitHub no garantiza el orden de entrega, y una
// `synchronize` vieja que llegara después del merge devolvería la PR a abierta.
// Por tiempo y no por rango porque `closed → reopened` es legal.
//
// `occurred_at` no se pisa: es la primera vez que se vio.
func (r *GitHubRepository) UpsertGitLink(l *domain.TaskGitLink) (bool, error) {
	if l.ID == "" {
		l.ID = uuid.NewString()
	}
	res := r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "item_id"}, {Name: "repo_id"}, {Name: "kind"}, {Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"title", "html_url", "author_login", "state", "head_branch", "base_branch",
			"head_sha", "merged_at", "github_updated_at", "updated_at",
		}),
		Where: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: `EXCLUDED.github_updated_at IS NULL
			OR task_git_links.github_updated_at IS NULL
			OR EXCLUDED.github_updated_at >= task_git_links.github_updated_at`}}},
	}).Create(l)
	return res.RowsAffected > 0, res.Error
}

// MarkBranchDeleted marca una rama como borrada en todas las tareas que la
// tienen, y dice cuáles eran (para avisarlas). Se conserva la fila, como Jira:
// la rama de una PR fusionada casi siempre se borra, y eso es historia.
func (r *GitHubRepository) MarkBranchDeleted(repoID int64, branch string) ([]domain.TaskGitLink, error) {
	var links []domain.TaskGitLink
	if err := r.db.Where("repo_id = ? AND kind = ? AND key = ? AND state <> ?",
		repoID, domain.GitLinkBranch, branch, domain.BranchDeleted).Find(&links).Error; err != nil {
		return nil, err
	}
	if len(links) == 0 {
		return nil, nil
	}
	err := r.db.Model(&domain.TaskGitLink{}).
		Where("repo_id = ? AND kind = ? AND key = ?", repoID, domain.GitLinkBranch, branch).
		Updates(map[string]any{"state": domain.BranchDeleted, "updated_at": time.Now()}).Error
	return links, err
}

// GitLinksOf: lo enlazado a una tarea, agrupado y en orden. Nil si la tabla no
// existe (una base sin este módulo): el detalle de una tarea no puede caerse
// por esto.
func GitLinksOf(db *gorm.DB, itemID string) (*domain.TaskGitLinks, error) {
	if !db.Migrator().HasTable(&domain.TaskGitLink{}) {
		return nil, nil
	}
	var rows []domain.TaskGitLink
	if err := db.Where("item_id = ?", itemID).Order("occurred_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := &domain.TaskGitLinks{
		Branches: []domain.TaskGitLink{}, PRs: []domain.TaskGitLink{}, Commits: []domain.TaskGitLink{},
	}
	open, merged, closed := 0, 0, 0
	for _, l := range rows {
		switch l.Kind {
		case domain.GitLinkBranch:
			out.Branches = append(out.Branches, l)
		case domain.GitLinkPR:
			out.PRs = append(out.PRs, l)
			switch l.State {
			case domain.PRStateOpen, domain.PRStateDraft:
				open++
			case domain.PRStateMerged:
				merged++
			default:
				closed++
			}
		case domain.GitLinkCommit:
			out.Summary.Commits++
			if len(out.Commits) < domain.MaxGitCommitsShown {
				out.Commits = append(out.Commits, l)
			}
		}
	}
	out.Summary.Branches, out.Summary.PRs = len(out.Branches), len(out.PRs)
	out.Summary.PRBadge = domain.GitBadge(open, merged, closed)
	if len(rows) == 0 {
		return nil, nil
	}
	return out, nil
}

// GitSummaries: el resumen de cada tarjeta de un tablero, en una consulta
// agrupada. Las tarjetas sin nada no salen.
func GitSummaries(db *gorm.DB, itemIDs []string) map[string]domain.GitSummary {
	out := map[string]domain.GitSummary{}
	if len(itemIDs) == 0 || !db.Migrator().HasTable(&domain.TaskGitLink{}) {
		return out
	}
	type fila struct {
		ItemID, Kind, State string
		N                   int
	}
	var filas []fila
	if err := db.Model(&domain.TaskGitLink{}).Select("item_id, kind, state, count(*) AS n").
		Where("item_id IN ?", itemIDs).Group("item_id, kind, state").Scan(&filas).Error; err != nil {
		return out
	}
	type cuenta struct{ open, merged, closed int }
	prs := map[string]*cuenta{}
	for _, f := range filas {
		s := out[f.ItemID]
		switch f.Kind {
		case domain.GitLinkBranch:
			s.Branches += f.N
		case domain.GitLinkCommit:
			s.Commits += f.N
		case domain.GitLinkPR:
			s.PRs += f.N
			c := prs[f.ItemID]
			if c == nil {
				c = &cuenta{}
				prs[f.ItemID] = c
			}
			switch f.State {
			case domain.PRStateOpen, domain.PRStateDraft:
				c.open += f.N
			case domain.PRStateMerged:
				c.merged += f.N
			default:
				c.closed += f.N
			}
		}
		out[f.ItemID] = s
	}
	for id, c := range prs {
		s := out[id]
		s.PRBadge = domain.GitBadge(c.open, c.merged, c.closed)
		out[id] = s
	}
	return out
}
