package repository

import (
	"strings"
	"time"

	"github.com/google/uuid"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

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
// Tasks de la organización, con texto completo: título, descripción y
// comentarios (ver search_index.go), con lo que casa en el título primero.
//
// El fragmento sale **sólo de la descripción**, y sólo si es ahí donde está lo
// buscado. Un comentario puede ser interno, y el trozo de un hilo enseñado
// fuera de su hilo es justo lo que el comentario de este fichero dice que no se
// hace.
func (r *SearchRepository) Tasks(query, orgID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	if orgID == "" {
		return out, nil
	}
	tsq := domain.SearchTSQuery(query)
	if tsq == "" {
		return out, nil
	}
	// Una referencia de cac escrita tal cual (`proteus-34`, el folio `acme-7`)
	// es esa tarea, la primera, aunque su texto no la nombre: es su nombre.
	// En mayúsculas no: `PROTEUS-34` es Jira, y eso lo busca el texto.
	direct := r.taskByRef(query, orgID)
	if direct != nil {
		out = append(out, *direct)
	}
	type row struct {
		ID, Title, ListName, Snippet string
	}
	var rows []row
	err := r.db.Raw(`
		WITH q AS (SELECT to_tsquery('cac_simple', ?) AS q),
		hits AS (
			SELECT t.id, ts_rank_cd(t.search, q.q) AS score FROM items t, q
			WHERE t.org_id = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.search @@ q.q
			UNION ALL
			SELECT t.id, ts_rank_cd(c.search, q.q) FROM item_comments c JOIN items t ON t.id = c.item_id, q
			WHERE t.org_id = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL
			  AND c.deleted_at IS NULL AND c.search @@ q.q
		),
		best AS (
			SELECT h.id, max(h.score) AS score,
			       bool_or(to_tsvector('cac_simple', t.title) @@ q.q) AS in_title, max(t.updated_at) AS updated_at
			FROM hits h JOIN items t ON t.id = h.id, q
			GROUP BY h.id
			ORDER BY in_title DESC, score DESC, updated_at DESC
			LIMIT ?
		)
		SELECT t.id, t.title, l.name AS list_name,
		       CASE WHEN to_tsvector('cac_simple', coalesce(t.description, '')) @@ q.q
		            THEN ts_headline('cac_simple', replace(t.description, '<', chr(57344)), q.q,
		              'StartSel=⟦, StopSel=⟧, MaxFragments=2, MaxWords=14, MinWords=6, FragmentDelimiter=" … "')
		            ELSE '' END AS snippet
		FROM best b JOIN items t ON t.id = b.id JOIN task_lists l ON l.id = t.list_id CROSS JOIN q
		ORDER BY b.in_title DESC, b.score DESC, b.updated_at DESC`,
		tsq, orgID, orgID, limit).Scan(&rows).Error
	if err != nil {
		return r.tasksLike(query, orgID, limit)
	}
	for _, x := range rows {
		if direct != nil && x.ID == direct.ID {
			continue
		}
		out = append(out, domain.SearchHit{
			Kind: domain.SearchTask, ID: x.ID, Title: x.Title, Snippet: domain.CleanSnippet(x.Snippet),
			Where: x.ListName, Link: "/tasks?task=" + x.ID,
		})
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// taskByRef: la tarea que nombra la consulta, si la consulta es sólo una
// referencia de cac en minúsculas. `nil` si no lo es o no existe.
func (r *SearchRepository) taskByRef(query, orgID string) *domain.SearchHit {
	q := strings.TrimSpace(query)
	refs := domain.ExtractTaskRefs(q, false)
	if len(refs) != 1 || refs[0].Slug == "" || domain.SpaceTaskRef(refs[0].Slug, refs[0].Seq) != q {
		return nil
	}
	it, err := (&TaskRepository{db: r.db}).FindByRef([]string{orgID}, refs[0])
	if err != nil || it == nil || it.ArchivedAt != nil {
		return nil
	}
	var list string
	r.db.Table("task_lists").Select("name").Where("id = ?", it.ListID).Scan(&list)
	return &domain.SearchHit{Kind: domain.SearchTask, ID: it.ID, Title: it.Title, Where: list, Link: "/tasks?task=" + it.ID}
}

// tasksLike es la búsqueda de antes, por `LIKE`, para una base sin el índice
// de texto completo.
func (r *SearchRepository) tasksLike(query, orgID string, limit int) ([]domain.SearchHit, error) {
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
	q := like(query)
	// El título, la descripción y los comentarios (#89).
	//
	// Sólo el título se quedaba corto justo para lo que más se busca: el nombre
	// de un comando, un error, un host — cosas que viven en la descripción o en
	// el hilo, no en el título. Los comentarios borrados no cuentan: un texto
	// retirado no puede seguir haciendo aparecer su tarea. Los internos sí, que
	// esto lo usa el equipo.
	//
	// Primero lo que casa en el título: es lo que casi siempre se quería, y un
	// acierto en un comentario de hace un año no debería taparlo.
	err := r.db.Table("items t").
		Select("t.id, t.title, t.seq, l.name AS list_name").
		Joins("JOIN task_lists l ON l.id = t.list_id").
		Where("t.org_id = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL", orgID).
		Where(`(LOWER(t.title) LIKE ? OR LOWER(t.description) LIKE ? OR EXISTS (
			SELECT 1 FROM item_comments c
			WHERE c.item_id = t.id AND c.deleted_at IS NULL AND LOWER(c.body) LIKE ?))`, q, q, q).
		// Un solo `ORDER BY`, a propósito. Con dos llamadas a `Order` —la
		// expresión y luego `t.updated_at DESC`— GORM **tira la primera sin
		// decir nada**: el SQL salía sólo con la fecha, y el título nunca iba
		// primero. Se vio sacando el SQL, no leyendo el código.
		Order(clause.OrderBy{Expression: clause.Expr{
			SQL:                "CASE WHEN LOWER(t.title) LIKE ? THEN 0 ELSE 1 END, t.updated_at DESC",
			Vars:               []any{q},
			WithoutParentheses: true,
		}}).
		Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchTask, ID: x.ID, Title: x.Title,
			Where: x.ListName, Link: "/tasks?task=" + x.ID,
		})
	}
	return out, err
}

// Notes are personal: the fence is the owner, not the organization. Con texto
// completo y fragmento: la nota es de quien busca, así que enseñarle el trozo
// no saca nada de ningún sitio.
func (r *SearchRepository) Notes(query, ownerID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	tsq := domain.SearchTSQuery(query)
	if tsq == "" {
		return out, nil
	}
	type row struct{ ID, Title, Snippet string }
	var rows []row
	err := r.db.Raw(`
		WITH q AS (SELECT to_tsquery('cac_simple', ?) AS q),
		best AS (
			SELECT n.id, n.title, n.body, ts_rank_cd(n.search, q.q) AS score, n.updated_at
			FROM notes n, q
			WHERE n.owner_id = ? AND n.deleted_at IS NULL AND n.search @@ q.q
			ORDER BY score DESC, n.updated_at DESC
			LIMIT ?
		)
		SELECT b.id, b.title,
		       CASE WHEN to_tsvector('cac_simple', coalesce(b.body, '')) @@ q.q
		            THEN ts_headline('cac_simple', replace(b.body, '<', chr(57344)), q.q,
		              'StartSel=⟦, StopSel=⟧, MaxFragments=2, MaxWords=14, MinWords=6, FragmentDelimiter=" … "')
		            ELSE '' END AS snippet
		FROM best b CROSS JOIN q
		ORDER BY b.score DESC, b.updated_at DESC`,
		tsq, ownerID, limit).Scan(&rows).Error
	if err != nil {
		return r.notesLike(query, ownerID, limit)
	}
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchNote, ID: x.ID, Title: x.Title, Snippet: domain.CleanSnippet(x.Snippet), Link: "/notes/" + x.ID,
		})
	}
	return out, nil
}

// notesLike: la de antes, para una base sin el índice.
func (r *SearchRepository) notesLike(query, ownerID string, limit int) ([]domain.SearchHit, error) {
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

// Docs de la organización: las pestañas de cada portada y las páginas, con
// texto completo (ver search_index.go).
//
// Ordenado por relevancia (`ts_rank_cd`, con el título de una página pesando
// más que el cuerpo) y con el trozo donde aparece lo buscado (`ts_headline`).
// El fragmento se calcula **después** de quedarse con los mejores: sobre todos
// los aciertos costaría lo que cuesta resaltar cientos de páginas enteras para
// enseñar ocho.
//
// Si la búsqueda de texto no está montada —las columnas no existen en una base
// vieja o de pruebas—, se cae a la de siempre por `LIKE` en vez de fallar.
func (r *SearchRepository) Docs(query, orgID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	if orgID == "" {
		return out, nil
	}
	tsq := domain.SearchTSQuery(query)
	if tsq == "" {
		return out, nil
	}
	type row struct {
		Src, OwnerKind, OwnerID, Tab, PageID, PageTitle, Name, Snippet, Body string
	}
	// Los .md de los repos atados (docs as code), sólo los que el repo sigue
	// enseñando; el «dónde» va en `tab`: repo/ruta. Sólo si la tabla tiene su
	// índice: una base de pruebas sin ella caería entera a `docsLike`, sin
	// páginas, por una tabla que no busca.
	// Y una página que es copia de un `.md` atado (mismo texto) no sale: manda
	// el repo, y devolver cada cosa dos veces dejaba la mitad de aciertos.
	repoPart, mirrorPart, args := "", "", []any{tsq, orgID, orgID}
	if r.hasSearchColumn("repo_docs") {
		mirrorPart = `AND NOT EXISTS (SELECT 1 FROM repo_docs rd JOIN git_hub_repos gr ON gr.repo_id = rd.repo_id AND gr.org_id = rd.org_id
				          WHERE rd.org_id = p.org_id AND gr.show_docs AND gr.space_id <> '' AND rd.body <> '' AND md5(rd.body) = md5(p.body))`
		repoPart = `UNION ALL
				SELECT 'repo', '', '', gr.full_name || '/' || rd.path, rd.id, rd.title, rd.body,
				       ts_rank_cd(rd.search, q.q), rd.updated_at
				FROM repo_docs rd JOIN git_hub_repos gr ON gr.repo_id = rd.repo_id AND gr.org_id = rd.org_id, q
				WHERE rd.org_id = ? AND gr.show_docs AND gr.space_id <> '' AND rd.search @@ q.q`
		args = append(args, orgID)
	}
	// Las decisiones vigentes del registro de cada documento; el «dónde» es el
	// nodo. Una sustituida no sale: lo que se busca es lo que vale hoy.
	decisionPart := ""
	if r.hasSearchColumn("decisions") {
		decisionPart = `UNION ALL
				SELECT 'decision', d.owner_kind, d.owner_id, '', dec.id, dec.title, dec.body,
				       ts_rank_cd(dec.search, q.q), dec.decided_at
				FROM decisions dec JOIN docs d ON d.id = dec.doc_id, q
				WHERE d.org_id = ? AND dec.search @@ q.q
				  AND NOT EXISTS (SELECT 1 FROM decisions n WHERE n.supersedes_id = dec.id)`
		args = append(args, orgID)
	}
	args = append(args, limit)
	var rows []row
	err := r.db.Raw(`
		WITH q AS (SELECT to_tsquery('cac_simple', ?) AS q),
		best AS (
			SELECT * FROM (
				SELECT 'tab' AS src, d.owner_kind, d.owner_id, t.key AS tab, '' AS page_id,
				       '' AS page_title, t.body, ts_rank_cd(t.search, q.q) AS score, t.updated_at
				FROM doc_tabs t JOIN docs d ON d.id = t.doc_id, q
				WHERE d.org_id = ? AND t.search @@ q.q
				UNION ALL
				SELECT 'page', d.owner_kind, d.owner_id, '', p.id, p.title, p.body,
				       ts_rank_cd(p.search, q.q), p.updated_at
				FROM doc_pages p JOIN docs d ON d.id = p.doc_id, q
				WHERE p.org_id = ? AND p.deleted_at IS NULL AND p.search @@ q.q
				`+mirrorPart+`
				`+repoPart+`
				`+decisionPart+`
			) x
			ORDER BY score DESC, updated_at DESC
			LIMIT ?
		)
		SELECT b.src, b.owner_kind, b.owner_id, b.tab, b.page_id, b.page_title,
		       COALESCE(sp.name, f.name, l.name, '') AS name, coalesce(b.body, '') AS body,
		       ts_headline('cac_simple', replace(coalesce(b.body, ''), '<', chr(57344)), q.q,
		         'StartSel=⟦, StopSel=⟧, MaxFragments=2, MaxWords=14, MinWords=6, FragmentDelimiter=" … "') AS snippet
		FROM best b CROSS JOIN q
		LEFT JOIN task_spaces sp ON b.owner_kind = 'space' AND sp.id = b.owner_id
		LEFT JOIN task_folders f ON b.owner_kind = 'folder' AND f.id = b.owner_id
		LEFT JOIN task_lists l ON b.owner_kind = 'list' AND l.id = b.owner_id
		ORDER BY b.score DESC, b.updated_at DESC`,
		args...).Scan(&rows).Error
	if err != nil {
		return r.docsLike(query, orgID, limit)
	}
	for _, x := range rows {
		if x.Src == "repo" {
			out = append(out, domain.SearchHit{
				Kind: domain.SearchRepoDoc, ID: x.PageID, Title: x.PageTitle, Where: x.Tab,
				Snippet: domain.CleanSnippet(x.Snippet), Link: "/docs?repoDoc=" + x.PageID,
				Section: domain.SearchSection(x.Body, query),
			})
			continue
		}
		link := "/tasks?doc=" + x.OwnerKind + ":" + x.OwnerID
		if x.Src == "decision" {
			out = append(out, domain.SearchHit{
				Kind: domain.SearchDecision, ID: x.PageID, Title: x.PageTitle,
				Where: x.Name + " › decisiones", Snippet: domain.CleanSnippet(x.Snippet),
				OwnerKind: x.OwnerKind, OwnerID: x.OwnerID, Link: link + "&tab=decisions",
			})
			continue
		}
		hit := domain.SearchHit{
			Kind: domain.SearchDoc, ID: x.OwnerID, Snippet: domain.CleanSnippet(x.Snippet),
			OwnerKind: x.OwnerKind, OwnerID: x.OwnerID,
			Section: domain.SearchSection(x.Body, query),
		}
		if x.Src == "page" {
			hit.ID, hit.PageID, hit.Title = x.PageID, x.PageID, x.PageTitle
			// La ruta, para saber de qué página hablamos sin abrirla: el nodo y
			// las madres, como las migas de pan de la propia página.
			path := []string{x.Name}
			if crumbs, err := (&DocRepository{db: r.db}).Breadcrumb(x.PageID); err == nil {
				for _, c := range crumbs {
					path = append(path, c.Title)
				}
			}
			hit.Where = strings.Join(path, " › ")
			hit.Link = link + "&page=" + x.PageID
		} else {
			hit.Title, hit.Where, hit.Tab = x.Name, x.Tab, x.Tab
			hit.Link = link + "&tab=" + x.Tab
		}
		out = append(out, hit)
	}
	return out, nil
}

// docsLike es la búsqueda de antes, por `LIKE`, para una base sin el índice de
// texto completo. Sólo pestañas: una base sin el índice tampoco tiene páginas
// de las que fiarse.
func (r *SearchRepository) docsLike(query, orgID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
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
			Where: x.Key, OwnerKind: x.OwnerKind, OwnerID: x.OwnerID, Tab: x.Key,
			Link: "/tasks?doc=" + x.OwnerKind + ":" + x.OwnerID + "&tab=" + x.Key,
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
//
// Y con una org, sólo los de esa org. Un directo es de dos personas **en una
// org**, y sin este filtro la paleta de la org B enseñaba mensajes de la A
// —tuyos, pero de otro cliente— con un enlace que los abría dentro de B. Sin
// org, los de todas: siguen siendo sólo los tuyos, y cada uno dice la suya.
func (r *SearchRepository) DMs(query, orgID, userID string, limit int) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	type row struct {
		ID, Body, ConversationID, Other, OrgID string
	}
	var rows []row
	q := r.db.Table("dm_conversations c").
		Select(`m.id, m.body, c.id AS conversation_id, c.org_id AS org_id,
			CASE WHEN c.user_lo_id = ? THEN c.user_hi_id ELSE c.user_lo_id END AS other`, userID).
		Joins("JOIN dm_messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL").
		Where("c.user_lo_id = ? OR c.user_hi_id = ?", userID, userID).
		Where("LOWER(m.body) LIKE ?", like(query))
	if orgID != "" {
		q = q.Where("c.org_id = ?", orgID)
	}
	err := q.Order("m.created_at DESC").Limit(limit).Scan(&rows).Error
	for _, x := range rows {
		out = append(out, domain.SearchHit{
			Kind: domain.SearchDM, ID: x.ID, Title: snippet(x.Body),
			Link: "/dm?c=" + x.ConversationID, OrgID: x.OrgID,
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

// hasSearchColumn: si la tabla existe y tiene su columna de texto completo
// (ver EnsureSearchIndexes).
func (r *SearchRepository) hasSearchColumn(table string) bool {
	var ok bool
	r.db.Raw(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_name = ? AND column_name = 'search')`, table).Scan(&ok)
	return ok
}

// RecordMiss guarda una búsqueda de agente sin aciertos (ver domain.SearchMiss)
// y poda las de más de 90 días. Best effort: si falla, la búsqueda ya contestó.
func (r *SearchRepository) RecordMiss(userID, orgID, query string) error {
	// Por caracteres: cortar por bytes puede partir una «ó» y Postgres
	// rechaza el UTF-8 roto. La columna también cuenta caracteres.
	if r := []rune(query); len(r) > 200 {
		query = string(r[:200])
	}
	if err := r.db.Create(&domain.SearchMiss{
		ID: uuid.NewString(), UserID: userID, OrgID: orgID, Query: query,
	}).Error; err != nil {
		return err
	}
	return r.db.Where("created_at < ?", time.Now().AddDate(0, 0, -90)).Delete(&domain.SearchMiss{}).Error
}
