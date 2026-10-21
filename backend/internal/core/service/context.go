package service

import (
	"errors"
	"slices"
	"strings"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ContextService junta el mapa de contexto de un espacio (domain.ContextMap).
// Sólo lee; quién puede pedirlo lo decide el handler.
type ContextService struct {
	tasks  *repository.TaskRepository
	docs   *repository.DocRepository
	github *repository.GitHubRepository
	repo   *repository.ContextRepository
}

func NewContextService(db *gorm.DB) *ContextService {
	return &ContextService{
		tasks:  repository.NewTaskRepository(db),
		docs:   repository.NewDocRepository(db),
		github: repository.NewGitHubRepository(db),
		repo:   repository.NewContextRepository(db),
	}
}

// ErrContextRepoNotLinked: el repo no está atado a ningún espacio de las
// organizaciones de quien pregunta (o no existe para él, que es lo mismo).
var ErrContextRepoNotLinked = errors.New("context-repo-not-linked")

// ResolveRepo: el espacio al que está atado `owner/name`, entre las
// organizaciones dadas. Un repo conectado pero sin espacio no cuenta.
func (s *ContextService) ResolveRepo(fullName string, orgIDs []string) (spaceID, orgID string, err error) {
	fullName = strings.TrimSpace(fullName)
	for _, o := range orgIDs {
		r, err := s.github.FindRepoByName(o, fullName)
		if err == nil && r.SpaceID != "" {
			return r.SpaceID, r.OrgID, nil
		}
	}
	return "", "", ErrContextRepoNotLinked
}

// Map junta el mapa de un espacio de `orgID`. `repo` va en la respuesta si el
// espacio se resolvió por él.
func (s *ContextService) Map(orgID, spaceID string, repo *domain.ContextRepo) (domain.ContextMap, error) {
	out := domain.ContextMap{Repo: repo, Nodes: []domain.ContextNode{}, RepoDocs: []domain.ContextRepoDoc{}, InProgress: []domain.ContextTask{}}
	trees, err := s.tasks.Tree([]string{orgID}, false, orgID)
	if err != nil {
		return out, err
	}
	var tree *domain.SpaceTree
	for i := range trees {
		if trees[i].ID == spaceID {
			tree = &trees[i]
		}
	}
	if tree == nil {
		return out, gorm.ErrRecordNotFound
	}
	out.Space = domain.ContextSpace{ID: tree.ID, Name: tree.Name, OrgID: orgID, OrgName: s.repo.OrgName(orgID)}

	// El árbol, en el orden del navegador: el espacio, sus listas sueltas, y
	// cada carpeta con lo suyo.
	out.Nodes = append(out.Nodes, domain.ContextNode{Kind: domain.DocOwnerSpace, ID: tree.ID, Name: tree.Name, Path: tree.Name, ProjectID: tree.ProjectID})
	addLists := func(path string, lists []domain.ListSummary) {
		for _, l := range lists {
			out.Nodes = append(out.Nodes, domain.ContextNode{
				Kind: domain.DocOwnerList, ID: l.ID, Name: l.Name, Path: path + " › " + l.Name,
				ProjectID: l.ProjectID, OpenCount: int(l.OpenCount),
			})
		}
	}
	addLists(tree.Name, tree.Lists)
	var addFolders func(path string, folders []domain.FolderTree)
	addFolders = func(path string, folders []domain.FolderTree) {
		for _, f := range folders {
			p := path + " › " + f.Name
			out.Nodes = append(out.Nodes, domain.ContextNode{Kind: domain.DocOwnerFolder, ID: f.ID, Name: f.Name, Path: p})
			addLists(p, f.Lists)
			addFolders(p, f.Folders)
		}
	}
	addFolders(tree.Name, tree.Folders)

	if err := s.attachDocs(orgID, &out); err != nil {
		return out, err
	}

	repoDocs, err := s.repo.RepoDocs(orgID, spaceID, domain.ContextMaxRepoDocs)
	if err != nil {
		return out, err
	}
	if len(repoDocs) > domain.ContextMaxRepoDocs {
		repoDocs = repoDocs[:domain.ContextMaxRepoDocs]
		out.Truncated = append(out.Truncated, "repoDocs")
	}
	out.RepoDocs = append(out.RepoDocs, repoDocs...)

	tasks, err := s.repo.InProgress(spaceID, domain.ContextMaxInProgress)
	if err != nil {
		return out, err
	}
	if len(tasks) > domain.ContextMaxInProgress {
		tasks = tasks[:domain.ContextMaxInProgress]
		out.Truncated = append(out.Truncated, "inProgress")
	}
	out.InProgress = append(out.InProgress, tasks...)
	return out, nil
}

// attachDocs pone a cada nodo el índice de su documento, si lo tiene escrito.
func (s *ContextService) attachDocs(orgID string, out *domain.ContextMap) error {
	ids := make([]string, len(out.Nodes))
	for i, n := range out.Nodes {
		ids[i] = n.ID
	}
	docs, err := s.repo.Docs(orgID, ids)
	if err != nil || len(docs) == 0 {
		return err
	}
	marks, err := s.docs.HasDoc(orgID)
	if err != nil {
		return err
	}
	docIDs := make([]string, len(docs))
	byOwner := map[string]string{} // "kind:id" → doc
	for i, d := range docs {
		docIDs[i] = d.ID
		byOwner[string(d.OwnerKind)+":"+d.OwnerID] = d.ID
	}
	tabs, err := s.repo.Tabs(docIDs)
	if err != nil {
		return err
	}
	pages, err := s.repo.Pages(docIDs)
	if err != nil {
		return err
	}
	decisions, err := s.repo.Decisions(docIDs)
	if err != nil {
		return err
	}

	built := map[string]*domain.ContextDoc{}
	get := func(docID string) *domain.ContextDoc {
		if built[docID] == nil {
			built[docID] = &domain.ContextDoc{Tabs: []domain.ContextTab{}}
		}
		return built[docID]
	}
	// Las pestañas en su orden de siempre, no en el que salgan de la base.
	order := map[domain.DocTabKey]int{}
	for i, k := range domain.DocTabKeys {
		order[k] = i
	}
	for _, t := range tabs {
		d := get(t.DocID)
		d.Tabs = append(d.Tabs, domain.ContextTab{
			Key: t.Key, Chars: len([]rune(t.Body)),
			Headings: domain.MarkdownHeadings(t.Body, domain.ContextMaxHeadingLevel),
		})
	}
	for _, d := range built {
		slices.SortStableFunc(d.Tabs, func(a, b domain.ContextTab) int { return order[a.Key] - order[b.Key] })
	}
	truncatedPages, truncatedDecisions := false, false
	for _, p := range pages {
		d := get(p.DocID)
		if len(d.Pages) == domain.ContextMaxPagesPerDoc {
			truncatedPages = true
			continue
		}
		d.Pages = append(d.Pages, domain.ContextPage{ID: p.ID, Title: p.Title, ParentID: p.ParentID})
	}
	for _, x := range decisions {
		d := get(x.DocID)
		if len(d.Decisions) == domain.ContextMaxDecisions {
			truncatedDecisions = true
			continue
		}
		d.Decisions = append(d.Decisions, domain.ContextDecision{Title: x.Title, Tag: x.Tag, DecidedAt: x.DecidedAt})
	}
	if truncatedPages {
		out.Truncated = append(out.Truncated, "pages")
	}
	if truncatedDecisions {
		out.Truncated = append(out.Truncated, "decisions")
	}

	for i := range out.Nodes {
		n := &out.Nodes[i]
		key := string(n.Kind) + ":" + n.ID
		d := built[byOwner[key]]
		if d == nil {
			continue
		}
		if m, ok := marks[key]; ok {
			d.Maintainer, d.ReviewedAt, d.Stale = m.MaintainerName, m.ReviewedAt, m.Stale
		}
		n.Doc = d
	}
	return nil
}

func (s *ContextService) FindSpace(id string) (*domain.TaskSpace, error) {
	return s.tasks.FindSpace(id)
}
