package repository

import (
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/rank"
)

var (
	ErrDocPageNotFound = errors.New("doc page not found")
	// ErrDocPageCycle: mover una página dentro de sí misma o de una hija suya.
	ErrDocPageCycle = errors.New("a page cannot hang from itself or from its own subpages")
	// ErrDocPageParent: la madre no es de este documento, o está en la papelera.
	ErrDocPageParent = errors.New("that parent page is not in this document")
)

// siblings filtra las hermanas de una posición: mismo documento y misma madre.
// La madre nula se compara con `IS NULL`: `parent_id = NULL` no casa nunca.
func siblings(db *gorm.DB, docID string, parentID *string) *gorm.DB {
	q := db.Model(&domain.DocPage{}).Where("doc_id = ?", docID)
	if parentID == nil {
		return q.Where("parent_id IS NULL")
	}
	return q.Where("parent_id = ?", *parentID)
}

// rankFor calcula el rango de una página que se coloca entre sus hermanas.
//
// Con `after`, justo detrás de ella; con `before`, justo delante; sin ninguna,
// al final. `skip` es la propia página cuando se mueve: no puede ser vecina de
// sí misma.
func rankFor(db *gorm.DB, docID string, parentID, after, before *string, skip string) (string, error) {
	pick := func(q *gorm.DB) (string, error) {
		var r []string
		if err := q.Limit(1).Pluck("rank", &r).Error; err != nil {
			return "", err
		}
		if len(r) == 0 {
			return "", nil
		}
		return r[0], nil
	}
	base := func() *gorm.DB {
		q := siblings(db, docID, parentID)
		if skip != "" {
			q = q.Where("id <> ?", skip)
		}
		return q
	}
	switch {
	case after != nil:
		var a domain.DocPage
		if err := base().Where("id = ?", *after).First(&a).Error; err != nil {
			return "", ErrDocPageParent
		}
		next, err := pick(base().Where("rank > ?", a.Rank).Order("rank ASC"))
		if err != nil {
			return "", err
		}
		return rank.Between(a.Rank, next), nil
	case before != nil:
		var b domain.DocPage
		if err := base().Where("id = ?", *before).First(&b).Error; err != nil {
			return "", ErrDocPageParent
		}
		prev, err := pick(base().Where("rank < ?", b.Rank).Order("rank DESC"))
		if err != nil {
			return "", err
		}
		return rank.Between(prev, b.Rank), nil
	default:
		last, err := pick(base().Order("rank DESC"))
		if err != nil {
			return "", err
		}
		return rank.Between(last, ""), nil
	}
}

// checkParent: la madre existe, es de este documento y no está en la papelera.
func checkParent(db *gorm.DB, docID string, parentID *string) error {
	if parentID == nil {
		return nil
	}
	var n int64
	if err := db.Model(&domain.DocPage{}).Where("id = ? AND doc_id = ?", *parentID, docID).
		Count(&n).Error; err != nil {
		return err
	}
	if n == 0 {
		return ErrDocPageParent
	}
	return nil
}

// PageTree: el árbol de un documento, sin cuerpos, en orden. Con `trashed`, lo
// que hay en la papelera (sólo la cima de cada subárbol borrado).
func (r *DocRepository) PageTree(docID string, trashed bool) ([]domain.DocPageTreeItem, error) {
	out := []domain.DocPageTreeItem{}
	type fila struct {
		ID        string
		ParentID  *string
		Rank      string
		Title     string
		HasBody   bool
		UpdatedAt time.Time
		DeletedAt *time.Time
	}
	var filas []fila
	q := r.db.Unscoped().Model(&domain.DocPage{}).
		Select("id, parent_id, rank::text AS rank, title, (body IS NOT NULL AND body <> '') AS has_body, updated_at, deleted_at").
		Where("doc_id = ?", docID)
	if trashed {
		q = q.Where("deleted_at IS NOT NULL")
	} else {
		q = q.Where("deleted_at IS NULL")
	}
	if err := q.Order("rank ASC").Scan(&filas).Error; err != nil {
		return nil, err
	}
	enPapelera := map[string]bool{}
	if trashed {
		for _, f := range filas {
			enPapelera[f.ID] = true
		}
	}
	// La cima de cada página en la papelera, para contar lo que se fue con
	// ella: lo que se tiró a la vez (mismo instante, ver `TrashPage`), que es
	// justo lo que traerá restaurarla.
	madre := map[string]fila{}
	for _, f := range filas {
		madre[f.ID] = f
	}
	cima := func(f fila) string {
		for f.ParentID != nil {
			p, ok := madre[*f.ParentID]
			if !ok || p.DeletedAt == nil || f.DeletedAt == nil || !p.DeletedAt.Equal(*f.DeletedAt) {
				break
			}
			f = p
		}
		return f.ID
	}
	debajo := map[string]int{}
	if trashed {
		for _, f := range filas {
			if c := cima(f); c != f.ID {
				debajo[c]++
			}
		}
	}
	for _, f := range filas {
		// En la papelera, sólo la cima: borrar una página con diez hijas es una
		// cosa que hizo alguien, no once.
		if trashed && f.ParentID != nil && enPapelera[*f.ParentID] {
			continue
		}
		// Una página viva no tiene `DeletedAt` y no se le ha contado nada, así
		// que los dos campos sólo llegan llenos desde la papelera.
		out = append(out, domain.DocPageTreeItem{
			ID: f.ID, ParentID: f.ParentID, Rank: f.Rank, Title: f.Title,
			HasBody: f.HasBody, UpdatedAt: f.UpdatedAt,
			DeletedAt: f.DeletedAt, Subpages: debajo[f.ID],
		})
	}
	if trashed {
		// Lo último que se tiró, arriba: es lo que se viene a buscar.
		sort.SliceStable(out, func(i, j int) bool { return out[i].DeletedAt.After(*out[j].DeletedAt) })
	}
	return out, nil
}

// CreatePage crea una página, y el documento si aún no había: escribir la
// primera página de una lista sin documentación es la forma normal de empezar
// una, igual que con `SaveTab`.
func (r *DocRepository) CreatePage(
	orgID string, kind domain.DocOwnerKind, ownerID string,
	req domain.CreateDocPageRequest, userID string,
) (*domain.DocPage, error) {
	doc, err := r.Patch(orgID, kind, ownerID, nil)
	if err != nil {
		return nil, err
	}
	p := &domain.DocPage{
		DocID: doc.ID, OrgID: doc.OrgID, ParentID: req.ParentID,
		Title: strings.TrimSpace(req.Title), Body: req.Body, BodyHash: HashBody(req.Body),
		UpdatedBy: userID,
	}
	if req.Body == "" {
		p.BodyHash = ""
	}
	p.ID = uuid.NewString()
	err = r.db.Transaction(func(tx *gorm.DB) error {
		if err := checkParent(tx, doc.ID, req.ParentID); err != nil {
			return err
		}
		rk, err := rankFor(tx, doc.ID, req.ParentID, req.AfterID, nil, "")
		if err != nil {
			return err
		}
		p.Rank = rk
		return tx.Create(p).Error
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

// FindPage: una página viva de este documento. La guarda anti-IDOR es el
// `doc_id`: una página de otro documento no existe para quien pregunta por éste.
func (r *DocRepository) FindPage(docID, pageID string) (*domain.DocPage, error) {
	var p domain.DocPage
	err := r.db.Where("id = ? AND doc_id = ?", pageID, docID).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrDocPageNotFound
	}
	if err != nil {
		return nil, err
	}
	p.UpdatedByName = r.AuthorName(p.UpdatedBy)
	return &p, nil
}

// SavePage cambia título y/o cuerpo. Lo que viene a nil no se toca.
//
// El texto anterior entra al historial antes de pisarlo, con la misma regla de
// fusión que las pestañas.
func (r *DocRepository) SavePage(p *domain.DocPage, title, body *string, userID string) error {
	fields := map[string]any{"updated_by": userID}
	changed := false
	if title != nil && strings.TrimSpace(*title) != p.Title {
		fields["title"] = strings.TrimSpace(*title)
		changed = true
	}
	if body != nil && *body != p.Body {
		fields["body"] = *body
		fields["body_hash"] = HashBody(*body)
		changed = true
		r.guardarVersionPagina(p, userID)
	}
	if !changed {
		return nil
	}
	return r.db.Model(&domain.DocPage{}).Where("id = ?", p.ID).Updates(fields).Error
}

func (r *DocRepository) guardarVersionPagina(p *domain.DocPage, userID string) {
	if p.Body == "" {
		return
	}
	var ultima domain.DocPageVersion
	err := r.db.Where("page_id = ?", p.ID).Order("created_at DESC").First(&ultima).Error
	if err == nil && domain.DocVersionMerges(&domain.DocVersion{AuthorID: ultima.AuthorID, BaseModel: ultima.BaseModel}, userID, time.Now()) {
		r.db.Model(&domain.DocPageVersion{}).Where("id = ?", ultima.ID).Update("created_at", time.Now())
		return
	}
	v := &domain.DocPageVersion{PageID: p.ID, Title: p.Title, Body: p.Body, AuthorID: userID}
	v.ID = uuid.NewString()
	if err := r.db.Create(v).Error; err != nil {
		return
	}
	var ids []string
	if err := r.db.Model(&domain.DocPageVersion{}).Where("page_id = ?", p.ID).
		Order("created_at DESC").Offset(domain.DocVersionKeep).Pluck("id", &ids).Error; err == nil && len(ids) > 0 {
		r.db.Where("id IN ?", ids).Delete(&domain.DocPageVersion{})
	}
}

// AppendPage añade al final sin leer antes, por lo mismo que `AppendTab`: quien
// tenga la página abierta autoguarda cada segundo y medio, y leer-concatenar-
// guardar le borraría lo que acaba de escribir.
func (r *DocRepository) AppendPage(pageID, texto, userID string) error {
	if strings.TrimSpace(texto) == "" {
		return nil
	}
	if err := r.db.Model(&domain.DocPage{}).Where("id = ?", pageID).Updates(map[string]any{
		"body":       gorm.Expr("CASE WHEN COALESCE(body, '') = '' THEN ? ELSE body || ? END", texto, "\n\n"+texto),
		"updated_by": userID,
	}).Error; err != nil {
		return err
	}
	var quedo string
	if err := r.db.Model(&domain.DocPage{}).Where("id = ?", pageID).Select("body").Scan(&quedo).Error; err != nil {
		return err
	}
	return r.db.Model(&domain.DocPage{}).Where("id = ?", pageID).Update("body_hash", HashBody(quedo)).Error
}

// MovePage cambia una página de sitio: otra madre, otro orden, o las dos.
//
// Una sola fila con un rango nuevo (`rank.Between`), y no el árbol entero como
// hacen las notas: aquí un agente por MCP y una persona pueden mover a la vez,
// y un árbol mandado desde una copia vieja desharía lo del otro sin avisar.
//
// El ciclo se comprueba **dentro** de la transacción y con las filas
// bloqueadas: dos movimientos cruzados (A bajo B mientras B bajo A) son cada
// uno legal por separado.
func (r *DocRepository) MovePage(docID, pageID string, req domain.MoveDocPageRequest) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		ids := []string{pageID}
		if req.ParentID != nil {
			ids = append(ids, *req.ParentID)
		}
		var bloqueadas []domain.DocPage
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id IN ? AND doc_id = ?", ids, docID).Find(&bloqueadas).Error; err != nil {
			return err
		}
		if len(bloqueadas) != len(ids) {
			if req.ParentID != nil && *req.ParentID != pageID {
				return ErrDocPageParent
			}
			if len(bloqueadas) == 0 {
				return ErrDocPageNotFound
			}
		}
		if req.ParentID != nil {
			if *req.ParentID == pageID {
				return ErrDocPageCycle
			}
			var ciclo int64
			if err := tx.Raw(`
				WITH RECURSIVE arriba AS (
					SELECT id, parent_id FROM doc_pages WHERE id = ? AND deleted_at IS NULL
					UNION ALL
					SELECT p.id, p.parent_id FROM doc_pages p JOIN arriba a ON p.id = a.parent_id
					WHERE p.deleted_at IS NULL
				)
				SELECT count(*) FROM arriba WHERE id = ?`, *req.ParentID, pageID).Scan(&ciclo).Error; err != nil {
				return err
			}
			if ciclo > 0 {
				return ErrDocPageCycle
			}
		}
		rk, err := rankFor(tx, docID, req.ParentID, req.AfterID, req.BeforeID, pageID)
		if err != nil {
			return err
		}
		return tx.Model(&domain.DocPage{}).Where("id = ?", pageID).
			Updates(map[string]any{"parent_id": req.ParentID, "rank": rk}).Error
	})
}

// TrashPage manda una página y todo lo que cuelga de ella a la papelera, **con
// la misma hora**: es lo que permite luego devolver sólo lo que se fue junto.
func (r *DocRepository) TrashPage(docID, pageID string) (int, error) {
	var ids []string
	if err := r.db.Raw(`
		WITH RECURSIVE sub AS (
			SELECT id FROM doc_pages WHERE id = ? AND doc_id = ? AND deleted_at IS NULL
			UNION ALL
			SELECT p.id FROM doc_pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
		)
		SELECT id FROM sub`, pageID, docID).Scan(&ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, ErrDocPageNotFound
	}
	ahora := time.Now()
	if err := r.db.Unscoped().Model(&domain.DocPage{}).Where("id IN ?", ids).
		Update("deleted_at", ahora).Error; err != nil {
		return 0, err
	}
	return len(ids), nil
}

// RestorePage devuelve una página de la papelera con lo que se fue con ella —y
// sólo eso: una hija que se borró antes, por su cuenta, se queda donde está—.
// Si su madre sigue en la papelera, vuelve colgando de la portada en vez de
// quedarse invisible bajo una página que no se ve.
func (r *DocRepository) RestorePage(docID, pageID string) error {
	var raiz domain.DocPage
	if err := r.db.Unscoped().Where("id = ? AND doc_id = ? AND deleted_at IS NOT NULL", pageID, docID).
		First(&raiz).Error; err != nil {
		return ErrDocPageNotFound
	}
	cuando := raiz.DeletedAt.Time
	var ids []string
	if err := r.db.Raw(`
		WITH RECURSIVE sub AS (
			SELECT id FROM doc_pages WHERE id = ?
			UNION ALL
			SELECT p.id FROM doc_pages p JOIN sub ON p.parent_id = sub.id
			WHERE p.deleted_at = ?
		)
		SELECT id FROM sub`, pageID, cuando).Scan(&ids).Error; err != nil {
		return err
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Model(&domain.DocPage{}).Where("id IN ?", ids).
			Update("deleted_at", nil).Error; err != nil {
			return err
		}
		if raiz.ParentID != nil {
			var viva int64
			tx.Model(&domain.DocPage{}).Where("id = ?", *raiz.ParentID).Count(&viva)
			if viva == 0 {
				return tx.Model(&domain.DocPage{}).Where("id = ?", pageID).Update("parent_id", nil).Error
			}
		}
		return nil
	})
}

// Breadcrumb: las madres de una página, de la raíz hacia abajo.
func (r *DocRepository) Breadcrumb(pageID string) ([]domain.DocPageCrumb, error) {
	type fila struct {
		ID, Title string
		Depth     int
	}
	var filas []fila
	if err := r.db.Raw(`
		WITH RECURSIVE arriba AS (
			SELECT parent_id AS id, 1 AS depth FROM doc_pages WHERE id = ?
			UNION ALL
			SELECT p.parent_id, a.depth + 1 FROM doc_pages p JOIN arriba a ON p.id = a.id
			WHERE a.depth < 64
		)
		SELECT p.id, p.title, a.depth FROM arriba a JOIN doc_pages p ON p.id = a.id
		ORDER BY a.depth DESC`, pageID).Scan(&filas).Error; err != nil {
		return nil, err
	}
	out := make([]domain.DocPageCrumb, 0, len(filas))
	for _, f := range filas {
		out = append(out, domain.DocPageCrumb{ID: f.ID, Title: f.Title})
	}
	return out, nil
}

// Children: las hijas vivas de una página (o de la portada, con nil), en orden.
func (r *DocRepository) Children(docID string, parentID *string) ([]domain.DocPageTreeItem, error) {
	out := []domain.DocPageTreeItem{}
	err := siblings(r.db, docID, parentID).
		Select("id, parent_id, rank::text AS rank, title, (body IS NOT NULL AND body <> '') AS has_body, updated_at").
		Order("rank ASC").Scan(&out).Error
	return out, err
}

// PageVersions: el historial de una página, lo más reciente primero.
func (r *DocRepository) PageVersions(pageID string) ([]domain.DocPageVersion, error) {
	var out []domain.DocPageVersion
	if err := r.db.Where("page_id = ?", pageID).Order("created_at DESC").
		Limit(domain.DocVersionKeep).Find(&out).Error; err != nil {
		return nil, err
	}
	for i := range out {
		out[i].AuthorName = r.AuthorName(out[i].AuthorID)
	}
	return out, nil
}

// FindPageVersion comprueba que la versión es **de esta página**: sin eso, un
// id de versión ajeno restauraría texto de otro documento aquí.
func (r *DocRepository) FindPageVersion(pageID, versionID string) (*domain.DocPageVersion, error) {
	var v domain.DocPageVersion
	if err := r.db.Where("id = ? AND page_id = ?", versionID, pageID).First(&v).Error; err != nil {
		return nil, err
	}
	return &v, nil
}

// AttachmentCited dice si un adjunto del documento sigue citado en alguna
// pestaña o página. **Las de la papelera cuentan**: una página borrada sigue
// citando su imagen, y restaurarla no puede encontrar un hueco.
//
// En SQL y no cargando todos los cuerpos: con páginas de 130 000 caracteres,
// leerlo todo en cada autoguardado sería caro para contestar un sí o un no.
func (r *DocRepository) AttachmentCited(docID, attID string) (bool, error) {
	var n int64
	pat := "%" + attID + "%"
	err := r.db.Raw(`
		SELECT (SELECT count(*) FROM doc_tabs WHERE doc_id = ? AND body LIKE ?)
		     + (SELECT count(*) FROM doc_pages WHERE doc_id = ? AND body LIKE ?)
		     + (SELECT count(*) FROM docs WHERE id = ? AND body LIKE ?)`,
		docID, pat, docID, pat, docID, pat).Scan(&n).Error
	return n > 0, err
}

// PageCounts: cuántas páginas vivas tiene cada documento de una organización.
func (r *DocRepository) PageCounts(orgID string) map[string]int {
	type fila struct {
		DocID string
		N     int
	}
	var filas []fila
	r.db.Model(&domain.DocPage{}).Select("doc_id, count(*) AS n").
		Where("org_id = ?", orgID).Group("doc_id").Scan(&filas)
	out := make(map[string]int, len(filas))
	for _, f := range filas {
		out[f.DocID] = f.N
	}
	return out
}

// PageBacklinks: lo que enlaza a una página dentro de su organización. Ver
// `domain.DocBacklink`. Sin la propia página, sin lo que está en la papelera
// y sin tareas borradas o archivadas: un enlace que nadie puede ver no es una
// referencia.
func (r *DocRepository) PageBacklinks(orgID, pageID string) ([]domain.DocBacklink, error) {
	out := []domain.DocBacklink{}
	type fila struct {
		Kind, ID, Title, OwnerKind, OwnerID, Name string
	}
	var filas []fila
	pat := "%page=" + pageID + "%"
	err := r.db.Raw(`
		SELECT kind, id, title, owner_kind, owner_id, name FROM (
			SELECT 'page' AS kind, p.id, p.title, d.owner_kind, d.owner_id,
			       COALESCE(sp.name, f.name, l.name, '') AS name, p.updated_at AS at
			FROM doc_pages p JOIN docs d ON d.id = p.doc_id
			LEFT JOIN task_spaces sp ON d.owner_kind = 'space' AND sp.id = d.owner_id
			LEFT JOIN task_folders f ON d.owner_kind = 'folder' AND f.id = d.owner_id
			LEFT JOIN task_lists l ON d.owner_kind = 'list' AND l.id = d.owner_id
			WHERE p.org_id = ? AND p.deleted_at IS NULL AND p.id <> ? AND p.body LIKE ?
			UNION ALL
			SELECT 'tab', t.key, '', d.owner_kind, d.owner_id,
			       COALESCE(sp.name, f.name, l.name, ''), t.updated_at
			FROM doc_tabs t JOIN docs d ON d.id = t.doc_id
			LEFT JOIN task_spaces sp ON d.owner_kind = 'space' AND sp.id = d.owner_id
			LEFT JOIN task_folders f ON d.owner_kind = 'folder' AND f.id = d.owner_id
			LEFT JOIN task_lists l ON d.owner_kind = 'list' AND l.id = d.owner_id
			WHERE d.org_id = ? AND t.body LIKE ?
			UNION ALL
			SELECT 'task', i.id, i.title, '', '', l.name, i.updated_at
			FROM items i JOIN task_lists l ON l.id = i.list_id
			WHERE i.org_id = ? AND i.deleted_at IS NULL AND i.archived_at IS NULL AND i.description LIKE ?
		) x
		ORDER BY at DESC
		LIMIT ?`,
		orgID, pageID, pat, orgID, pat, orgID, pat, domain.MaxDocBacklinks).Scan(&filas).Error
	if err != nil {
		return out, err
	}
	for _, f := range filas {
		b := domain.DocBacklink{Kind: f.Kind, Title: f.Title, Where: f.Name}
		switch f.Kind {
		case "page":
			b.Link = "/tasks?doc=" + f.OwnerKind + ":" + f.OwnerID + "&page=" + f.ID
		case "tab":
			// La pestaña se nombra en la app por su clave; el título es el nodo.
			b.Title, b.Where = f.Name, f.ID
			b.Link = "/tasks?doc=" + f.OwnerKind + ":" + f.OwnerID + "&tab=" + f.ID
		case "task":
			b.Link = "/tasks?task=" + f.ID
		}
		out = append(out, b)
	}
	return out, nil
}
