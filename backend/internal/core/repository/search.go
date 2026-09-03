package repository

import (
	"strings"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// SearchRepository answers the palette. One method per source, and every method
// carries its own fence — see domain.SearchResults for why they are never
// merged into a single query.
type SearchRepository struct{ db *gorm.DB }

func NewSearchRepository(db *gorm.DB) *SearchRepository { return &SearchRepository{db: db} }

func like(q string) string { return "%" + strings.ToLower(strings.TrimSpace(q)) + "%" }

// Tasks in one organization the caller belongs to. Client-facing items are
// included: this is cac's own console, and a report is work like any other.
func (r *SearchRepository) Tasks(query, orgID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	if orgID == "" {
		// A missing organization must not widen the search to every one of
		// them. Same rule as the people search, for the same reason.
		return out, nil
	}
	type row struct {
		ID, Title, ListName string
		Seq                 int
	}
	var rows []row
	err := r.db.Table("items t").
		Select("t.id, t.title, t.seq, l.name AS list_name").
		Joins("JOIN task_lists l ON l.id = t.list_id").
		Where("t.org_id = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL", orgID).
		Where("LOWER(t.title) LIKE ?", like(query)).
		Order("t.updated_at DESC").Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchTask, ID: x.ID, Title: x.Title,
			Where: x.ListName, Link: "/tasks?task=" + x.ID,
		})
	}
	return out, err
}

// Notes are personal: the fence is the owner, not the organization.
func (r *SearchRepository) Notes(query, ownerID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	type row struct{ ID, Title string }
	var rows []row
	err := r.db.Table("notes").
		Select("id, title").
		Where("owner_id = ? AND deleted_at IS NULL", ownerID).
		Where("LOWER(title) LIKE ? OR LOWER(body) LIKE ?", like(query), like(query)).
		Order("updated_at DESC").Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchNote, ID: x.ID, Title: x.Title, Link: "/notes/" + x.ID,
		})
	}
	return out, err
}

// Docs de la organización, buscando en el texto de las secciones.
//
// Se busca en `doc_tabs` y no en `docs`: desde que el documento se reparte en
// cuatro pestañas, el cuerpo de la fila padre está vacío en todos los nuevos, y
// una búsqueda contra él encontraría sólo los de antes.
//
// El nombre del nodo se resuelve con tres `LEFT JOIN` y no con tres consultas:
// un documento cuelga de un espacio, una carpeta o una lista, y sin el nombre la
// fila del resultado sería un identificador que nadie reconoce.
func (r *SearchRepository) Docs(query, orgID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	if orgID == "" {
		return out, nil
	}
	type row struct {
		OwnerKind, OwnerID, Key, Name string
	}
	var rows []row
	err := r.db.Table("doc_tabs").
		Select(`docs.owner_kind AS owner_kind, docs.owner_id AS owner_id, doc_tabs.key AS key,
			COALESCE(task_spaces.name, task_folders.name, task_lists.name, '') AS name`).
		Joins("JOIN docs ON docs.id = doc_tabs.doc_id").
		Joins("LEFT JOIN task_spaces ON docs.owner_kind = 'space' AND task_spaces.id = docs.owner_id").
		Joins("LEFT JOIN task_folders ON docs.owner_kind = 'folder' AND task_folders.id = docs.owner_id").
		Joins("LEFT JOIN task_lists ON docs.owner_kind = 'list' AND task_lists.id = docs.owner_id").
		Where("docs.org_id = ?", orgID).
		Where("LOWER(doc_tabs.body) LIKE ?", like(query)).
		Order("doc_tabs.updated_at DESC").Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchDoc, ID: x.OwnerID, Title: x.Name,
			Where: x.Key,
			Link:  "/tasks?doc=" + x.OwnerKind + ":" + x.OwnerID + "&tab=" + x.Key,
		})
	}
	return out, err
}

// People you share an organization with.
func (r *SearchRepository) People(query, orgID, excludeID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	if orgID == "" {
		return out, nil
	}
	type row struct{ ID, Username string }
	var rows []row
	err := r.db.Table("users").
		Select("users.id, users.username").
		Joins("JOIN org_memberships m ON m.user_id = users.id AND m.org_id = ?", orgID).
		Where("users.id <> ?", excludeID).
		Where("LOWER(users.username) LIKE ?", like(query)).
		Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			// `?u=` y no `/dm` a secas: la pantalla abre la conversación con
			// esa persona, creándola si aún no existe. Enlazar a la lista
			// pelada dejaba al que busca a un nombre de distancia de lo que
			// acababa de encontrar.
			Kind: domain.SearchPerson, ID: x.ID, Title: x.Username,
			Link: "/dm?u=" + x.ID,
		})
	}
	return out, err
}

// Channel messages of one organization. Readable by everyone in the channel,
// which is everyone in the space, which is why the organization is the fence.
func (r *SearchRepository) Messages(query, orgID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	if orgID == "" {
		return out, nil
	}
	type row struct{ ID, Body, SpaceID, SpaceName string }
	var rows []row
	err := r.db.Table("chat_messages c").
		Select("c.id, c.body, sp.id AS space_id, sp.name AS space_name").
		Joins("JOIN task_spaces sp ON sp.id = c.space_id").
		Where("sp.org_id = ? AND c.deleted_at IS NULL", orgID).
		Where("LOWER(c.body) LIKE ?", like(query)).
		Order("c.created_at DESC").Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchMessage, ID: x.ID, Title: snippet(x.Body),
			Where: "#" + x.SpaceName, Link: "/chat?space=" + x.SpaceID,
		})
	}
	return out, err
}

// DMs starts from the conversations the caller is in, and only then looks at
// messages.
//
// The direction matters and is the point. Starting from `dm_messages` and
// filtering afterwards would be one forgotten clause away from returning other
// people's conversations — and those tables were deliberately built with no
// visibility column precisely so that no filter has to be remembered. Starting
// from participation means the query cannot express somebody else's mail.
func (r *SearchRepository) DMs(query, userID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	type row struct {
		ID, Body, ConversationID, Other string
	}
	var rows []row
	err := r.db.Table("dm_conversations c").
		Select(`m.id, m.body, c.id AS conversation_id,
			CASE WHEN c.user_lo_id = ? THEN c.user_hi_id ELSE c.user_lo_id END AS other`, userID).
		Joins("JOIN dm_messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL").
		Where("c.user_lo_id = ? OR c.user_hi_id = ?", userID, userID).
		Where("LOWER(m.body) LIKE ?", like(query)).
		Order("m.created_at DESC").Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchDM, ID: x.ID, Title: snippet(x.Body),
			Link: "/dm?c=" + x.ConversationID,
		})
	}
	return out, err
}

// snippet keeps a hit to one line: enough to recognise, not enough to read.
func snippet(body string) string {
	body = strings.TrimSpace(strings.ReplaceAll(body, "\n", " "))
	if len(body) > 90 {
		return body[:90] + "…"
	}
	return body
}
