package repository

import (
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// ContextRepository: las consultas del mapa de contexto (domain.ContextMap).
// Una por cada cosa que se junta, nunca una por nodo: un espacio con treinta
// listas serían treinta idas a la base por pestaña.
type ContextRepository struct{ db *gorm.DB }

func NewContextRepository(db *gorm.DB) *ContextRepository { return &ContextRepository{db: db} }

// ContextDocRow: un documento de un nodo, con lo que hace falta para buscar
// sus pestañas, páginas y decisiones.
type ContextDocRow struct {
	ID        string
	OwnerKind domain.DocOwnerKind
	OwnerID   string
}

func (r *ContextRepository) Docs(orgID string, ownerIDs []string) ([]ContextDocRow, error) {
	var rows []ContextDocRow
	if len(ownerIDs) == 0 {
		return rows, nil
	}
	err := r.db.Table("docs").Select("id, owner_kind, owner_id").
		Where("org_id = ? AND owner_id IN ?", orgID, ownerIDs).Scan(&rows).Error
	return rows, err
}

// ContextTabRow: el cuerpo de una pestaña. Se lee entero aquí, en el servidor,
// para sacar sus títulos: lo que viaja al agente son los títulos.
type ContextTabRow struct {
	DocID string
	Key   domain.DocTabKey
	Body  string
}

func (r *ContextRepository) Tabs(docIDs []string) ([]ContextTabRow, error) {
	var rows []ContextTabRow
	if len(docIDs) == 0 {
		return rows, nil
	}
	err := r.db.Table("doc_tabs").Select("doc_id, key, body").
		Where("doc_id IN ? AND body <> ''", docIDs).Scan(&rows).Error
	return rows, err
}

type ContextPageRow struct {
	DocID    string
	ID       string
	Title    string
	ParentID *string
}

// Pages: las páginas fuera de la papelera, en el orden del árbol.
func (r *ContextRepository) Pages(docIDs []string) ([]ContextPageRow, error) {
	var rows []ContextPageRow
	if len(docIDs) == 0 {
		return rows, nil
	}
	err := r.db.Table("doc_pages").Select("doc_id, id, title, parent_id").
		Where("doc_id IN ? AND deleted_at IS NULL", docIDs).
		Order("rank ASC, created_at ASC").Scan(&rows).Error
	return rows, err
}

type ContextDecisionRow struct {
	DocID     string
	ID        string
	Title     string
	Tag       string
	DecidedAt time.Time
}

// Decisions: las vigentes, las más recientes primero; el servicio se queda con
// las primeras de cada documento. Una sustituida (`supersedes_id` de otra
// apunta a ella) no sale: el mapa dice lo que vale hoy.
func (r *ContextRepository) Decisions(docIDs []string) ([]ContextDecisionRow, error) {
	var rows []ContextDecisionRow
	if len(docIDs) == 0 {
		return rows, nil
	}
	err := r.db.Table("decisions d").Select("d.doc_id, d.id, d.title, d.tag, d.decided_at").
		Where("d.doc_id IN ? AND NOT EXISTS (SELECT 1 FROM decisions n WHERE n.supersedes_id = d.id)", docIDs).
		Order("d.decided_at DESC").Scan(&rows).Error
	return rows, err
}

// RepoDocs: los markdown de los repos atados al espacio que los enseñan, como
// los lista `RepoDocsForSpace`. Uno más del límite, para saber si se recortó.
func (r *ContextRepository) RepoDocs(orgID, spaceID string, limit int) ([]domain.ContextRepoDoc, error) {
	var rows []domain.ContextRepoDoc
	err := r.db.Table("repo_docs rd").
		Select("rd.id, gr.full_name AS repo, rd.path, rd.title").
		Joins("JOIN git_hub_repos gr ON gr.repo_id = rd.repo_id AND gr.org_id = rd.org_id").
		Where("rd.org_id = ? AND gr.space_id = ? AND gr.show_docs", orgID, spaceID).
		Order("gr.full_name, rd.path").Limit(limit + 1).Scan(&rows).Error
	return rows, err
}

// InProgress: las tareas en «en curso» de cualquier lista del espacio, sin
// subtareas ni archivadas, lo más reciente primero. Uno más del límite.
func (r *ContextRepository) InProgress(spaceID string, limit int) ([]domain.ContextTask, error) {
	// Una fila propia: GORM no sabe leer en un struct con un `[]string`
	// (los responsables), que se rellenan después.
	type row struct {
		ID, Title, ListID, ProjectID, Handoff, HandoffByID string
		Seq                                                int
		UpdatedAt                                          time.Time
		HandoffAt                                          *time.Time
	}
	var rows []row
	err := r.db.Table("items").Select("id, seq, title, list_id, project_id, updated_at, handoff, handoff_at, handoff_by_id").
		Where("space_id = ? AND status = ? AND parent_id IS NULL AND archived_at IS NULL AND deleted_at IS NULL",
			spaceID, domain.ReportInProgress).
		Order("updated_at DESC").Limit(limit + 1).Scan(&rows).Error
	out := make([]domain.ContextTask, len(rows))
	for i, x := range rows {
		out[i] = domain.ContextTask{
			ID: x.ID, Seq: x.Seq, Title: x.Title, ListID: x.ListID, ProjectID: x.ProjectID, UpdatedAt: x.UpdatedAt,
			Handoff: x.Handoff, HandoffAt: x.HandoffAt, HandoffByID: x.HandoffByID,
		}
	}
	return out, err
}

// AssigneesOf: los usuarios (por `username`, que es como se nombran en el MCP)
// responsables de cada tarea, en una consulta para todas.
func (r *ContextRepository) AssigneesOf(itemIDs []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(itemIDs) == 0 {
		return out, nil
	}
	type row struct{ ItemID, Username string }
	var rows []row
	err := r.db.Table("item_assignees a").Select("a.item_id, u.username").
		Joins("JOIN users u ON u.id = a.user_id").
		Where("a.item_id IN ?", itemIDs).Order("a.primary DESC, u.username").Scan(&rows).Error
	for _, x := range rows {
		out[x.ItemID] = append(out[x.ItemID], x.Username)
	}
	return out, err
}

// DisplayName: cómo se llama una persona (por `nombreVisible`); vacío si no
// existe.
func (r *ContextRepository) DisplayName(userID string) string {
	var name string
	r.db.Table("users").Select(nombreVisible).Where("id = ?", userID).Scan(&name)
	return name
}

// OrgName: el nombre de la organización, para que el agente sepa dónde está.
func (r *ContextRepository) OrgName(orgID string) string {
	var name string
	r.db.Table("organizations").Select("name").Where("id = ?", orgID).Scan(&name)
	return name
}
