package repository

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// ErrDecisionLinkNotFound: no hay un enlace vivo con ese id en esa decisión.
var ErrDecisionLinkNotFound = errors.New("decision link not found")

// SectionOrgID: de qué organización es una sección **viva**, y "" si no hay
// ninguna con ese id o ya se quitó. Como `TaskOrgID`, el error se devuelve.
func (r *DocRepository) SectionOrgID(sectionID string) (string, error) {
	var org string
	err := r.db.Raw(`SELECT COALESCE(org_id, '') FROM doc_sections WHERE id = ? AND removed_at IS NULL`, sectionID).
		Scan(&org).Error
	return org, err
}

// AddDecisionWithLinks apunta una decisión y sus enlaces en una transacción:
// una decisión no puede quedar escrita sin aquello a lo que dice aplicarse.
// Si la decisión ya estaba (el mismo comentario), sólo añade los enlaces que
// falten.
func (r *DocRepository) AddDecisionWithLinks(
	d *domain.Decision, orgID string, taskIDs, sectionIDs []string,
) (*domain.Decision, error) {
	var out *domain.Decision
	err := r.inTx(func(rt *DocRepository) error {
		saved, err := rt.AddDecision(d)
		if err != nil {
			return err
		}
		out = saved
		return rt.addLinks(saved.ID, orgID, taskIDs, sectionIDs, saved.AuthorID, saved.Via)
	})
	return out, err
}

// LinkDecision enlaza una decisión que ya existe. Lo que ya estaba enlazado no
// se repite.
func (r *DocRepository) LinkDecision(decisionID, orgID string, taskIDs, sectionIDs []string, userID, via string) error {
	return r.inTx(func(rt *DocRepository) error {
		return rt.addLinks(decisionID, orgID, taskIDs, sectionIDs, userID, via)
	})
}

func (r *DocRepository) addLinks(decisionID, orgID string, taskIDs, sectionIDs []string, userID, via string) error {
	add := func(task, section *string) error {
		l := &domain.DecisionLink{OrgID: orgID, DecisionID: decisionID, TaskID: task, SectionID: section,
			AddedByID: userID, Via: via}
		l.ID = uuid.NewString()
		// El índice único parcial (sólo los vivos) hace de «ya estaba».
		return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(l).Error
	}
	for _, id := range taskIDs {
		if err := add(&id, nil); err != nil {
			return err
		}
	}
	for _, id := range sectionIDs {
		if err := add(nil, &id); err != nil {
			return err
		}
	}
	return nil
}

// UnlinkDecision quita un enlace vivo: lo marca con quién y cuándo.
func (r *DocRepository) UnlinkDecision(decisionID, linkID, userID string) error {
	res := r.db.Model(&domain.DecisionLink{}).
		Where("id = ? AND decision_id = ? AND removed_at IS NULL", linkID, decisionID).
		Updates(map[string]any{"removed_at": time.Now(), "removed_by_id": userID})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrDecisionLinkNotFound
	}
	return nil
}

type linkRow struct {
	ID, DecisionID, Via string
	CreatedAt           time.Time
	TaskID              *string
	TaskTitle           string
	TaskStatus          string
	TaskSeq             int
	SpaceKey            string
	ProjectSlug         string
	SectionID           *string
	Heading             string
	SectionRemoved      bool
	Tab                 string
	PageID              *string
	PageTitle           string
	OwnerKind           string
	OwnerID             string
}

// decisionLinks: los enlaces vivos de unas decisiones, resueltos. Un enlace a
// una tarea borrada no sale: no hay a dónde ir. Uno a una sección quitada sí,
// con su último título, porque dice algo («esto se aplicaba a X»).
func (r *DocRepository) decisionLinks(decisionIDs []string) (map[string][]domain.DecisionLinkView, error) {
	out := map[string][]domain.DecisionLinkView{}
	if len(decisionIDs) == 0 {
		return out, nil
	}
	var rows []linkRow
	err := r.db.Raw(`
		SELECT l.id, l.decision_id, l.via, l.created_at,
		       l.task_id, COALESCE(i.title, '') AS task_title, COALESCE(i.status, '') AS task_status,
		       COALESCE(i.seq, 0) AS task_seq, COALESCE(sp.key, '') AS space_key, COALESCE(rp.slug, '') AS project_slug,
		       l.section_id, COALESCE(s.heading, '') AS heading, (s.removed_at IS NOT NULL) AS section_removed,
		       COALESCE(s.tab, '') AS tab, s.page_id, COALESCE(p.title, '') AS page_title,
		       COALESCE(d.owner_kind, '') AS owner_kind, COALESCE(d.owner_id, '') AS owner_id
		FROM decision_links l
		LEFT JOIN items i ON i.id = l.task_id
		LEFT JOIN task_spaces sp ON sp.id = i.space_id
		LEFT JOIN report_projects rp ON rp.id = i.project_id AND COALESCE(i.project_id, '') <> ''
		LEFT JOIN doc_sections s ON s.id = l.section_id
		LEFT JOIN doc_pages p ON p.id = s.page_id
		LEFT JOIN docs d ON d.id = s.doc_id
		WHERE l.decision_id IN ? AND l.removed_at IS NULL
		  AND (l.task_id IS NULL OR (i.id IS NOT NULL AND i.deleted_at IS NULL))
		ORDER BY l.created_at`, decisionIDs).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		v := domain.DecisionLinkView{ID: row.ID, AddedAt: row.CreatedAt, Via: row.Via}
		if row.TaskID != nil {
			v.Kind = domain.DecisionLinkTask
			v.TaskID, v.TaskTitle, v.TaskStatus = *row.TaskID, row.TaskTitle, row.TaskStatus
			if row.ProjectSlug != "" {
				v.TaskRef = domain.Folio(row.ProjectSlug, row.TaskSeq)
			} else {
				v.TaskRef = domain.SpaceTaskRef(row.SpaceKey, row.TaskSeq)
			}
		} else if row.SectionID != nil {
			v.Kind = domain.DecisionLinkSection
			v.SectionID, v.Heading, v.SectionRemoved = *row.SectionID, row.Heading, row.SectionRemoved
			v.Tab, v.PageTitle = domain.DocTabKey(row.Tab), row.PageTitle
			if row.PageID != nil {
				v.PageID = *row.PageID
			}
			v.OwnerKind, v.OwnerID = domain.DocOwnerKind(row.OwnerKind), row.OwnerID
		}
		out[row.DecisionID] = append(out[row.DecisionID], v)
	}
	return out, nil
}

type decisionRefRow struct {
	Key, ID, Title, OwnerKind, OwnerID, SupersededByID string
	DecidedAt                                          time.Time
}

const decisionRefSelect = `d.id, d.title, d.decided_at, COALESCE(doc.owner_kind, '') AS owner_kind,
	COALESCE(doc.owner_id, '') AS owner_id,
	COALESCE((SELECT n.id FROM decisions n WHERE n.supersedes_id = d.id LIMIT 1), '') AS superseded_by_id`

func toDecisionRefs(rows []decisionRefRow) map[string][]domain.DecisionRef {
	out := map[string][]domain.DecisionRef{}
	for _, row := range rows {
		out[row.Key] = append(out[row.Key], domain.DecisionRef{ID: row.ID, Title: row.Title,
			OwnerKind: domain.DocOwnerKind(row.OwnerKind), OwnerID: row.OwnerID,
			DecidedAt: row.DecidedAt, SupersededByID: row.SupersededByID})
	}
	return out
}

// SectionDecisions: las decisiones **vigentes** enlazadas a cada sección. Es
// el porqué de lo que dice; una sustituida ya no lo es.
func (r *DocRepository) SectionDecisions(sectionIDs []string) (map[string][]domain.DecisionRef, error) {
	if len(sectionIDs) == 0 {
		return map[string][]domain.DecisionRef{}, nil
	}
	var rows []decisionRefRow
	err := r.db.Raw(`SELECT l.section_id AS key, `+decisionRefSelect+`
		FROM decision_links l
		JOIN decisions d ON d.id = l.decision_id
		LEFT JOIN docs doc ON doc.id = d.doc_id
		WHERE l.section_id IN ? AND l.removed_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM decisions n WHERE n.supersedes_id = d.id)
		ORDER BY d.decided_at DESC`, sectionIDs).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return toDecisionRefs(rows), nil
}

// TaskDecisions: las decisiones enlazadas a una tarea, también las
// sustituidas: en una tarea, lo que se decidió en su día es parte de su
// historia, y la entrada dice quién la sustituyó.
func (r *DocRepository) TaskDecisions(taskID string) ([]domain.DecisionRef, error) {
	var rows []decisionRefRow
	err := r.db.Raw(`SELECT l.task_id AS key, `+decisionRefSelect+`
		FROM decision_links l
		JOIN decisions d ON d.id = l.decision_id
		LEFT JOIN docs doc ON doc.id = d.doc_id
		WHERE l.task_id = ? AND l.removed_at IS NULL
		ORDER BY d.decided_at DESC`, taskID).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := toDecisionRefs(rows)[taskID]
	if out == nil {
		out = []domain.DecisionRef{}
	}
	return out, nil
}

// withSectionDecisions pone en cada sección sus decisiones vigentes. Un fallo
// deja las secciones sin ellas: son un extra.
func (r *DocRepository) withSectionDecisions(views []domain.DocSectionView) {
	ids := make([]string, len(views))
	for i, v := range views {
		ids[i] = v.ID
	}
	by, err := r.SectionDecisions(ids)
	if err != nil {
		return
	}
	for i := range views {
		views[i].Decisions = by[views[i].ID]
	}
}

// EnsureDecisionLinkIndexes: un enlace vivo por decisión y tarea o sección.
// Parciales porque un enlace quitado se queda, y volver a enlazar lo mismo
// tiene que poder hacerse.
func EnsureDecisionLinkIndexes(db *gorm.DB) {
	for _, q := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_link_task ON decision_links (decision_id, task_id)
			WHERE removed_at IS NULL AND task_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_link_section ON decision_links (decision_id, section_id)
			WHERE removed_at IS NULL AND section_id IS NOT NULL`,
	} {
		if err := db.Exec(q).Error; err != nil {
			lg.Warn("decision links: cannot create index: " + err.Error())
		}
	}
}

// BackfillDecisionOriginLinks: la tarea de origen de cada decisión de antes
// es también un enlace, así «las tareas de una decisión» se leen de un solo
// sitio. Idempotente: el índice único no deja repetir.
func BackfillDecisionOriginLinks(db *gorm.DB) {
	err := db.Exec(`INSERT INTO decision_links (id, created_at, updated_at, org_id, decision_id, task_id, added_by_id, via)
		SELECT gen_random_uuid()::text, d.decided_at, d.decided_at, doc.org_id, d.id, d.origin_task_id, d.author_id, d.via
		FROM decisions d JOIN docs doc ON doc.id = d.doc_id
		JOIN items i ON i.id = d.origin_task_id AND i.deleted_at IS NULL
		WHERE d.origin = 'task' AND COALESCE(d.origin_task_id, '') <> ''
		  AND NOT EXISTS (SELECT 1 FROM decision_links l WHERE l.decision_id = d.id AND l.task_id = d.origin_task_id)
		ON CONFLICT DO NOTHING`).Error
	if err != nil {
		lg.Warn("decision links: cannot link origin tasks: " + err.Error())
	}
}

// SearchSections: secciones vivas de una org cuyo título contiene `q` (sin
// mayúsculas), para el selector que enlaza una decisión. Sin `q`, las
// primeras. Las de una página de la papelera no salen: no se puede ir a ellas.
func (r *DocRepository) SearchSections(orgID, q string, limit int) ([]domain.DocSectionHit, error) {
	out := []domain.DocSectionHit{}
	type row struct {
		ID, Heading, Tab, PageTitle, OwnerKind, OwnerID, OwnerName string
		Level                                                      int
		PageID                                                     *string
	}
	var rows []row
	err := r.db.Raw(`
		SELECT s.id, s.heading, s.level, s.tab, s.page_id, COALESCE(p.title, '') AS page_title,
		       d.owner_kind, d.owner_id, COALESCE(sp.name, f.name, l.name, '') AS owner_name
		FROM doc_sections s
		JOIN docs d ON d.id = s.doc_id
		LEFT JOIN doc_pages p ON p.id = s.page_id
		LEFT JOIN task_spaces sp ON d.owner_kind = 'space' AND sp.id = d.owner_id
		LEFT JOIN task_folders f ON d.owner_kind = 'folder' AND f.id = d.owner_id
		LEFT JOIN task_lists l ON d.owner_kind = 'list' AND l.id = d.owner_id
		WHERE s.org_id = ? AND s.removed_at IS NULL AND s.heading <> ''
		  AND (s.page_id IS NULL OR p.deleted_at IS NULL)
		  AND s.heading ILIKE ?
		ORDER BY length(s.heading), s.heading
		LIMIT ?`, orgID, "%"+escapeLike(q)+"%", limit).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, x := range rows {
		h := domain.DocSectionHit{ID: x.ID, Heading: x.Heading, Level: x.Level, Tab: domain.DocTabKey(x.Tab),
			PageTitle: x.PageTitle, OwnerKind: domain.DocOwnerKind(x.OwnerKind), OwnerID: x.OwnerID, OwnerName: x.OwnerName}
		if x.PageID != nil {
			h.PageID = *x.PageID
		}
		out = append(out, h)
	}
	return out, nil
}
