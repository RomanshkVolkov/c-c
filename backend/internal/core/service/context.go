package service

import (
	"errors"
	"slices"
	"strings"
	"time"

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

// Map junta el mapa entero de un espacio de `orgID`. `repo` va en la respuesta
// si el espacio se resolvió por él.
func (s *ContextService) Map(orgID, spaceID string, repo *domain.ContextRepo) (domain.ContextMap, error) {
	return s.MapWith(orgID, spaceID, repo, domain.ContextOptions{})
}

// MapWith: el mapa recortado como pidan las opciones (ver ContextOptions).
func (s *ContextService) MapWith(orgID, spaceID string, repo *domain.ContextRepo, opts domain.ContextOptions) (domain.ContextMap, error) {
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
	out.Space = domain.ContextSpace{ID: tree.ID, Name: tree.Name, Key: tree.Key, OrgID: orgID, OrgName: s.repo.OrgName(orgID)}

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

	// Los documentos de los nodos (los ids hacen falta también para los
	// cambios, así que se buscan una vez).
	ids := make([]string, len(out.Nodes))
	for i, n := range out.Nodes {
		ids[i] = n.ID
	}
	docs, err := s.repo.Docs(orgID, ids)
	if err != nil {
		return out, err
	}
	if opts.Wants("docs") {
		if err := s.attachDocs(orgID, &out, docs, opts.Node); err != nil {
			return out, err
		}
	}

	if opts.Wants("repoDocs") {
		repoDocs, err := s.repo.RepoDocs(orgID, spaceID, domain.ContextMaxRepoDocs)
		if err != nil {
			return out, err
		}
		if len(repoDocs) > domain.ContextMaxRepoDocs {
			repoDocs = repoDocs[:domain.ContextMaxRepoDocs]
			out.Truncated = append(out.Truncated, "repoDocs")
		}
		out.RepoDocs = append(out.RepoDocs, repoDocs...)
	}

	if opts.Wants("inProgress") {
		tasks, err := s.repo.InProgress(spaceID, domain.ContextMaxInProgress)
		if err != nil {
			return out, err
		}
		if len(tasks) > domain.ContextMaxInProgress {
			tasks = tasks[:domain.ContextMaxInProgress]
			out.Truncated = append(out.Truncated, "inProgress")
		}
		if err := s.decorateTasks(tree.Key, tasks); err != nil {
			return out, err
		}
		out.InProgress = append(out.InProgress, tasks...)
	}

	if opts.Since != nil && opts.Wants("changes") {
		changes, err := s.changes(orgID, spaceID, tree.Key, *opts.Since, out.Nodes, docs)
		if err != nil {
			return out, err
		}
		if len(changes.Tasks) > domain.ContextMaxInProgress {
			changes.Tasks = changes.Tasks[:domain.ContextMaxInProgress]
			out.Truncated = append(out.Truncated, "changes.tasks")
		}
		out.Changes = &changes
	}
	return out, nil
}

// decorateTasks pone a cada tarea lo que no sale de su fila: la referencia
// (el folio si es de un cliente; si no, la clave del espacio y el número),
// quién la lleva y quién escribió su «dónde quedó».
func (s *ContextService) decorateTasks(spaceKey string, tasks []domain.ContextTask) error {
	ids := make([]string, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID
	}
	assignees, err := s.repo.AssigneesOf(ids)
	if err != nil {
		return err
	}
	for i := range tasks {
		t := &tasks[i]
		if t.ProjectID == "" {
			t.Ref = domain.SpaceTaskRef(spaceKey, t.Seq)
		} else if slug := s.tasks.ProjectSlug(t.ProjectID); slug != "" {
			t.Ref = domain.Folio(slug, t.Seq)
		}
		t.Assignees = assignees[t.ID]
		if t.HandoffByID != "" {
			t.HandoffBy = s.repo.DisplayName(t.HandoffByID)
		}
	}
	return nil
}

// changes: lo que cambió desde `since`. Cada cosa con su nodo y su ruta, para
// saber qué mirar sin abrir nada.
func (s *ContextService) changes(orgID, spaceID, spaceKey string, since time.Time, nodes []domain.ContextNode, docs []repository.ContextDocRow) (domain.ContextChanges, error) {
	out := domain.ContextChanges{Since: since, Tasks: []domain.ContextTask{}, Decisions: []domain.ContextChangedDecision{},
		Docs: []domain.ContextChangedDoc{}, RepoDocs: []domain.ContextRepoDoc{}}
	tasks, err := s.repo.ChangedTasks(spaceID, since, domain.ContextMaxInProgress)
	if err != nil {
		return out, err
	}
	if err := s.decorateTasks(spaceKey, tasks); err != nil {
		return out, err
	}
	out.Tasks = append(out.Tasks, tasks...)

	path := map[string]domain.ContextNode{}
	for _, n := range nodes {
		path[n.ID] = n
	}
	docIDs := make([]string, len(docs))
	owner := map[string]domain.ContextNode{} // doc → nodo
	for i, d := range docs {
		docIDs[i] = d.ID
		owner[d.ID] = path[d.OwnerID]
	}
	decisions, err := s.repo.ChangedDecisions(docIDs, since)
	if err != nil {
		return out, err
	}
	for _, x := range decisions {
		n := owner[x.DocID]
		out.Decisions = append(out.Decisions, domain.ContextChangedDecision{
			ID: x.ID, Title: x.Title, Tag: x.Tag, DecidedAt: x.DecidedAt, OwnerKind: n.Kind, OwnerID: n.ID, Path: n.Path,
		})
	}
	edited, err := s.repo.ChangedDocs(docIDs, since)
	if err != nil {
		return out, err
	}
	for _, x := range edited {
		n := owner[x.DocID]
		out.Docs = append(out.Docs, domain.ContextChangedDoc{
			OwnerKind: n.Kind, OwnerID: n.ID, Path: n.Path, Tab: x.Key, PageID: x.PageID, PageTitle: x.PageTitle, UpdatedAt: x.UpdatedAt,
		})
	}
	repoDocs, err := s.repo.ChangedRepoDocs(orgID, spaceID, since)
	if err != nil {
		return out, err
	}
	out.RepoDocs = append(out.RepoDocs, repoDocs...)
	return out, nil
}

// attachDocs pone a cada nodo el índice de su documento, si lo tiene escrito.
// Con `node`, sólo a ése.
func (s *ContextService) attachDocs(orgID string, out *domain.ContextMap, docs []repository.ContextDocRow, node string) error {
	if node != "" {
		var only []repository.ContextDocRow
		for _, d := range docs {
			if d.OwnerID == node {
				only = append(only, d)
			}
		}
		docs = only
	}
	if len(docs) == 0 {
		return nil
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
	pages, err := s.repo.Pages(docIDs, orgID, out.Space.ID)
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
		d.Pages = append(d.Pages, domain.ContextPage{ID: p.ID, Title: p.Title, ParentID: p.ParentID, MirrorOf: p.MirrorOf})
	}
	for _, x := range decisions {
		d := get(x.DocID)
		if len(d.Decisions) == domain.ContextMaxDecisions {
			truncatedDecisions = true
			continue
		}
		d.Decisions = append(d.Decisions, domain.ContextDecision{ID: x.ID, Title: x.Title, Tag: x.Tag, DecidedAt: x.DecidedAt})
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
