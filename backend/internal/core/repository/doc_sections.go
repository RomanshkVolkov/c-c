package repository

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// sectionOwner: de quién son unas secciones, una pestaña o una página.
type sectionOwner struct {
	OrgID  string
	DocID  string
	Tab    domain.DocTabKey
	PageID *string
}

func tabOwner(doc *domain.Doc, key domain.DocTabKey) sectionOwner {
	return sectionOwner{OrgID: doc.OrgID, DocID: doc.ID, Tab: key}
}

func pageOwner(p *domain.DocPage) sectionOwner {
	id := p.ID
	return sectionOwner{OrgID: p.OrgID, DocID: p.DocID, PageID: &id}
}

func (o sectionOwner) scope(q *gorm.DB) *gorm.DB {
	q = q.Where("doc_id = ?", o.DocID)
	if o.PageID != nil {
		return q.Where("page_id = ?", *o.PageID)
	}
	return q.Where("tab = ? AND page_id IS NULL", o.Tab)
}

// inTx: `fn` con un repositorio atado a una transacción. Dentro de otra
// transacción, es un punto de guardado.
func (r *DocRepository) inTx(fn func(rt *DocRepository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error { return fn(&DocRepository{db: tx}) })
}

// syncSections pone las secciones guardadas al día con `body`, que es el
// cuerpo que acaba de quedar escrito (ver domain.ReconcileSections).
//
// Se llama dentro de la transacción de la escritura, después del UPDATE: la
// fila de la pestaña o la página ya está bloqueada, así que dos escrituras a
// la vez se reconcilian una detrás de otra y la segunda parte de lo que dejó
// la primera.
//
// En un punto de guardado propio, y un fallo **no** tumba la escritura:
// perder lo que alguien acaba de escribir es peor que una identidad atrasada,
// y la siguiente escritura la pone al día, porque reconciliar parte siempre de
// lo que hay.
func (r *DocRepository) syncSections(o sectionOwner, body string, hints map[string]string) {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		return reconcileSections(tx, o, body, hints, time.Now())
	})
	if err != nil {
		lg.Warn("doc sections: cannot reconcile " + o.DocID + ": " + err.Error())
	}
}

func reconcileSections(tx *gorm.DB, o sectionOwner, body string, hints map[string]string, now time.Time) error {
	var saved []domain.DocSection
	if err := o.scope(tx.Model(&domain.DocSection{})).Find(&saved).Error; err != nil {
		return err
	}
	rows := make([]domain.SectionRow, len(saved))
	byID := make(map[string]*domain.DocSection, len(saved))
	for i := range saved {
		s := &saved[i]
		rows[i] = domain.SectionRow{ID: s.ID, Heading: s.Heading, Level: s.Level,
			Ordinal: s.Ordinal, OwnText: s.OwnText, Removed: s.RemovedAt != nil}
		byID[s.ID] = s
	}
	parsed := domain.SplitSections(body)
	plan := domain.ReconcileSections(rows, parsed, hints)

	for _, m := range plan.Matches {
		s, p := byID[m.RowID], parsed[m.Parsed]
		if s.RemovedAt == nil && s.Heading == p.Heading && s.Level == p.Level &&
			s.Ordinal == p.Index && s.OwnText == p.OwnText {
			continue
		}
		if err := tx.Model(&domain.DocSection{}).Where("id = ?", s.ID).Updates(map[string]any{
			"heading": p.Heading, "level": p.Level, "ordinal": p.Index,
			"own_text": p.OwnText, "removed_at": nil,
		}).Error; err != nil {
			return err
		}
	}
	for _, i := range plan.New {
		p := parsed[i]
		s := &domain.DocSection{OrgID: o.OrgID, DocID: o.DocID, Tab: o.Tab, PageID: o.PageID,
			Heading: p.Heading, Level: p.Level, Ordinal: p.Index, OwnText: p.OwnText}
		s.ID = uuid.NewString()
		if err := tx.Create(s).Error; err != nil {
			return err
		}
	}
	if len(plan.Removed) > 0 {
		if err := tx.Model(&domain.DocSection{}).Where("id IN ?", plan.Removed).
			Update("removed_at", now).Error; err != nil {
			return err
		}
	}
	return nil
}

// liveSections: las secciones vivas de un documento, por pestaña o página
// (la clave es la pestaña, o el id de la página).
func (r *DocRepository) liveSections(docID string) (map[string][]domain.DocSectionView, error) {
	var rows []domain.DocSection
	if err := r.db.Where("doc_id = ? AND removed_at IS NULL", docID).
		Order("ordinal").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := map[string][]domain.DocSectionView{}
	for _, s := range rows {
		k := string(s.Tab)
		if s.PageID != nil {
			k = *s.PageID
		}
		out[k] = append(out[k], domain.DocSectionView{ID: s.ID, Heading: s.Heading, Level: s.Level, Index: s.Ordinal})
	}
	return out, nil
}

// backfillDocSections da identidad a las secciones de las pestañas y páginas
// escritas antes de que existiera (command-and-control-91).
//
// Corre en cada arranque y sólo toca lo que aún no tiene ninguna fila. Es
// idempotente porque reconciliar lo es: un pod que escribe a la vez durante un
// despliegue rodante no deja secciones duplicadas.
func backfillDocSections(db *gorm.DB) {
	var tabs []pendingTab
	if err := db.Raw(`SELECT t.id, t.doc_id, d.org_id, t.key FROM doc_tabs t JOIN docs d ON d.id = t.doc_id
		WHERE COALESCE(t.body, '') <> '' AND NOT EXISTS (
			SELECT 1 FROM doc_sections s WHERE s.doc_id = t.doc_id AND s.tab = t.key AND s.page_id IS NULL)`).
		Scan(&tabs).Error; err != nil {
		lg.Warn("doc sections backfill: cannot read tabs: " + err.Error())
		return
	}
	for _, t := range tabs {
		if err := backfillTabSections(db, t); err != nil {
			lg.Warn("doc sections backfill: tab " + t.ID + ": " + err.Error())
		}
	}

	var pages []string
	if err := db.Raw(`SELECT p.id FROM doc_pages p WHERE COALESCE(p.body, '') <> '' AND NOT EXISTS (
			SELECT 1 FROM doc_sections s WHERE s.page_id = p.id)`).Scan(&pages).Error; err != nil {
		lg.Warn("doc sections backfill: cannot read pages: " + err.Error())
		return
	}
	for _, id := range pages {
		if err := backfillPageSections(db, id); err != nil {
			lg.Warn("doc sections backfill: page " + id + ": " + err.Error())
		}
	}
}

type pendingTab struct {
	ID, DocID, OrgID string
	Key              domain.DocTabKey
}

// backfillTabSections: las secciones de una pestaña sin ninguna, con la fila
// bloqueada. Si entre la consulta y aquí otro pod la escribió —y con ella sus
// secciones—, reconciliar empareja las que ya hay y no duplica nada.
func backfillTabSections(db *gorm.DB, t pendingTab) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var tab domain.DocTab
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", t.ID).First(&tab).Error; err != nil {
			return err
		}
		o := sectionOwner{OrgID: t.OrgID, DocID: t.DocID, Tab: t.Key}
		return reconcileSections(tx, o, tab.Body, nil, time.Now())
	})
}

// backfillPageSections: lo mismo para una página, también de la papelera:
// restaurarla no puede encontrarse las secciones sin id.
func backfillPageSections(db *gorm.DB, id string) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var p domain.DocPage
		if err := tx.Unscoped().Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", id).First(&p).Error; err != nil {
			return err
		}
		o := pageOwner(&p)
		return reconcileSections(tx, o, p.Body, nil, time.Now())
	})
}

// PageSections: las secciones vivas de una página.
func (r *DocRepository) PageSections(docID, pageID string) ([]domain.DocSectionView, error) {
	var rows []domain.DocSection
	if err := r.db.Where("doc_id = ? AND page_id = ? AND removed_at IS NULL", docID, pageID).
		Order("ordinal").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]domain.DocSectionView, len(rows))
	for i, s := range rows {
		out[i] = domain.DocSectionView{ID: s.ID, Heading: s.Heading, Level: s.Level, Index: s.Ordinal}
	}
	return out, nil
}
