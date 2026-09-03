package repository

import (
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var ErrDocOwnerNotFound = errors.New("doc owner not found")

type DocRepository struct{ db *gorm.DB }

func NewDocRepository(db *gorm.DB) *DocRepository { return &DocRepository{db: db} }

// OwnerOrg resolves the organization that owns a node, walking up the hierarchy
// (list → space, folder → space). Authorization for every doc operation hangs
// off this, so an unknown node is an error rather than a silent empty org.
func (r *DocRepository) OwnerOrg(kind domain.DocOwnerKind, id string) (string, error) {
	switch kind {
	case domain.DocOwnerSpace:
		var sp domain.TaskSpace
		if err := r.db.First(&sp, "id = ?", id).Error; err != nil {
			return "", ErrDocOwnerNotFound
		}
		return sp.OrgID, nil
	case domain.DocOwnerFolder:
		var f domain.TaskFolder
		if err := r.db.First(&f, "id = ?", id).Error; err != nil {
			return "", ErrDocOwnerNotFound
		}
		return r.OwnerOrg(domain.DocOwnerSpace, f.SpaceID)
	case domain.DocOwnerList:
		var l domain.TaskList
		if err := r.db.First(&l, "id = ?", id).Error; err != nil {
			return "", ErrDocOwnerNotFound
		}
		return r.OwnerOrg(domain.DocOwnerSpace, l.SpaceID)
	}
	return "", ErrDocOwnerNotFound
}

// Find returns the node's document, or nil when it has none yet. A node without
// a document is the normal state — the row is created on first save.
func (r *DocRepository) Find(kind domain.DocOwnerKind, id string) (*domain.Doc, error) {
	var d domain.Doc
	err := r.db.Where("owner_kind = ? AND owner_id = ?", kind, id).First(&d).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *DocRepository) FindByID(id string) (*domain.Doc, error) {
	var d domain.Doc
	if err := r.db.First(&d, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &d, nil
}

// Save upserts the node's document and returns it.
func (r *DocRepository) Save(orgID string, kind domain.DocOwnerKind, id, body, userID string) (*domain.Doc, error) {
	existing, err := r.Find(kind, id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		d := &domain.Doc{
			OrgID: orgID, OwnerKind: kind, OwnerID: id, Body: body, UpdatedBy: userID,
		}
		d.ID = uuid.NewString()
		if err := r.db.Create(d).Error; err != nil {
			return nil, err
		}
		return d, nil
	}
	if err := r.db.Model(&domain.Doc{}).Where("id = ?", existing.ID).
		Updates(map[string]any{"body": body, "updated_by": userID}).Error; err != nil {
		return nil, err
	}
	return r.FindByID(existing.ID)
}

// Tabs devuelve las cuatro secciones de un documento, **siempre las cuatro**.
//
// Las que no existen vuelven vacías en vez de faltar: una pestaña sin contenido
// se pinta en gris y no se oculta, porque su ausencia dice algo del proyecto.
// Resolver eso aquí evita que cada pantalla tenga que acordarse.
func (r *DocRepository) Tabs(docID string) ([]domain.DocTab, error) {
	var guardadas []domain.DocTab
	if err := r.db.Where("doc_id = ?", docID).Find(&guardadas).Error; err != nil {
		return nil, err
	}
	out := domain.ResolveDocTabs(docID, guardadas)
	for i := range out {
		if out[i].UpdatedBy != "" {
			out[i].UpdatedByName = r.AuthorName(out[i].UpdatedBy)
		}
	}
	return out, nil
}

// SaveTab guarda una sección, creando el documento si aún no existía.
//
// Crear el documento aquí y no exigirlo antes: escribir en una pestaña de una
// lista que nunca tuvo documentación es la forma normal de empezar uno, y pedir
// dos llamadas para eso sólo traslada el problema a quien llame.
func (r *DocRepository) SaveTab(
	orgID string, kind domain.DocOwnerKind, ownerID string,
	key domain.DocTabKey, body, userID string,
) (*domain.Doc, error) {
	doc, err := r.Find(kind, ownerID)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		doc = &domain.Doc{OrgID: orgID, OwnerKind: kind, OwnerID: ownerID, UpdatedBy: userID}
		doc.ID = uuid.NewString()
		if err := r.db.Create(doc).Error; err != nil {
			return nil, err
		}
	}

	var existente domain.DocTab
	err = r.db.Where("doc_id = ? AND key = ?", doc.ID, key).First(&existente).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		t := &domain.DocTab{DocID: doc.ID, Key: key, Body: body, UpdatedBy: userID}
		t.ID = uuid.NewString()
		if err := r.db.Create(t).Error; err != nil {
			return nil, err
		}
		return doc, nil
	}
	if err != nil {
		return nil, err
	}
	// Nada que guardar si nada cambió. El autoguardado dispara por tiempo, no
	// por cambio, así que sin esto cada latido escribiría una fila y correría la
	// ventana del historial sobre un texto idéntico.
	if existente.Body == body {
		return doc, nil
	}
	r.guardarVersion(doc.ID, key, existente.Body, userID)
	// `Updates` con mapa y no con struct: con struct, un cuerpo vaciado a
	// propósito es el valor cero y GORM no lo escribiría — vaciar una sección
	// dejaría de funcionar sin que nada se queje.
	if err := r.db.Model(&domain.DocTab{}).Where("id = ?", existente.ID).
		Updates(map[string]any{"body": body, "updated_by": userID}).Error; err != nil {
		return nil, err
	}
	return doc, nil
}

// guardarVersion apunta el texto **anterior** antes de pisarlo.
//
// Se fusiona con la última entrada de la misma persona dentro de la ventana en
// vez de añadir otra: el autoguardado dispara cada pocos segundos, y una fila
// por pulsación deja un historial ilegible, que es un historial que no sirve
// para volver a ningún sitio. Al fusionar se conserva el cuerpo **más viejo**
// de la ventana, que es el punto al que alguien querría regresar.
//
// Un error aquí no impide guardar: perder una entrada del historial es malo,
// perder lo que la persona acaba de escribir es peor.
func (r *DocRepository) guardarVersion(docID string, key domain.DocTabKey, anterior, userID string) {
	if anterior == "" {
		return
	}
	var ultima domain.DocVersion
	err := r.db.Where("doc_id = ? AND key = ?", docID, key).
		Order("created_at DESC").First(&ultima).Error
	if err == nil && domain.DocVersionMerges(&ultima, userID, time.Now()) {
		// Ya hay una entrada de esta sesión: lo que guarda es el texto de antes
		// de empezar, así que no se toca. Sólo se corre la fecha para que la
		// ventana se mida desde la última pulsación.
		r.db.Model(&domain.DocVersion{}).Where("id = ?", ultima.ID).
			Update("created_at", time.Now())
		return
	}
	v := &domain.DocVersion{DocID: docID, Key: key, Body: anterior, AuthorID: userID}
	v.ID = uuid.NewString()
	if err := r.db.Create(v).Error; err != nil {
		return
	}
	r.podarVersiones(docID, key)
}

// podarVersiones deja las más recientes y tira el resto.
func (r *DocRepository) podarVersiones(docID string, key domain.DocTabKey) {
	var ids []string
	if err := r.db.Model(&domain.DocVersion{}).
		Where("doc_id = ? AND key = ?", docID, key).
		Order("created_at DESC").Offset(domain.DocVersionKeep).
		Pluck("id", &ids).Error; err != nil || len(ids) == 0 {
		return
	}
	r.db.Where("id IN ?", ids).Delete(&domain.DocVersion{})
}

// Versions: el historial de una sección, lo más reciente primero.
func (r *DocRepository) Versions(docID string, key domain.DocTabKey, limit int) ([]domain.DocVersion, error) {
	var out []domain.DocVersion
	if err := r.db.Where("doc_id = ? AND key = ?", docID, key).
		Order("created_at DESC").Limit(limit).Find(&out).Error; err != nil {
		return nil, err
	}
	for i := range out {
		out[i].AuthorName = r.AuthorName(out[i].AuthorID)
	}
	return out, nil
}

// FindVersion busca una entrada, comprobando que es del documento que dice.
//
// El documento se pasa aparte y se comprueba aquí: sin eso, un id de versión de
// otra organización restauraría texto ajeno sobre este documento.
func (r *DocRepository) FindVersion(docID, versionID string) (*domain.DocVersion, error) {
	var v domain.DocVersion
	if err := r.db.Where("id = ? AND doc_id = ?", versionID, docID).First(&v).Error; err != nil {
		return nil, err
	}
	return &v, nil
}

// AppendTab añade al final de una sección sin leerla antes.
//
// Y ésa es toda la razón de que exista, en vez de dejar que quien llama lea,
// concatene y guarde: mientras eso viaja, la persona que tenga ese documento
// abierto está autoguardando cada segundo y medio. Una escritura basada en una
// lectura de hace medio segundo le borra el párrafo que acaba de escribir, y no
// se entera nadie. La concatenación la hace la base, sobre la fila.
//
// No pasa por el historial a propósito: guardar sólo se apunta cuando alguien
// **edita**, y lo que llega de un mensaje no es una edición de nadie. Apuntarlo
// llenaría el historial de entradas que no corresponden a ninguna sesión de
// escritura, que es lo que hace ilegible un historial.
func (r *DocRepository) AppendTab(
	orgID string, kind domain.DocOwnerKind, ownerID string,
	key domain.DocTabKey, texto, userID string,
) (*domain.Doc, error) {
	if strings.TrimSpace(texto) == "" {
		return r.Find(kind, ownerID)
	}
	doc, err := r.Patch(orgID, kind, ownerID, nil)
	if err != nil {
		return nil, err
	}
	var existente domain.DocTab
	err = r.db.Where("doc_id = ? AND key = ?", doc.ID, key).First(&existente).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		t := &domain.DocTab{DocID: doc.ID, Key: key, Body: texto, UpdatedBy: userID}
		t.ID = uuid.NewString()
		if err := r.db.Create(t).Error; err != nil {
			return nil, err
		}
		return doc, nil
	}
	if err != nil {
		return nil, err
	}
	// La concatenación en SQL, sobre la fila: es lo que hace que no haya lectura
	// que pueda quedarse vieja. Dos líneas en blanco porque en markdown una sola
	// pega el párrafo nuevo al anterior.
	if err := r.db.Model(&domain.DocTab{}).Where("id = ?", existente.ID).
		Updates(map[string]any{
			// `COALESCE` y no `body ||` a secas: en Postgres, `NULL || 'x'` es
			// `NULL`. Una fila con el cuerpo nulo —las hay, de antes de que esta
			// tabla existiera— se vaciaría en vez de crecer, y el texto que
			// hubiera se perdería sin que nada fallara.
			"body":       gorm.Expr("COALESCE(body, '') || ?", "\n\n"+texto),
			"updated_by": userID,
		}).Error; err != nil {
		return nil, err
	}
	return doc, nil
}

// HasDoc reports which of the given nodes carry a non-empty document, so the
// navigator can mark them without shipping every body.
func (r *DocRepository) HasDoc(orgID string) (map[string]domain.DocMark, error) {
	var rows []domain.Doc
	if err := r.db.Select("id", "owner_kind", "owner_id", "body", "pinned_line", "maintainer_id", "reviewed_at", "updated_at").
		Where("org_id = ?", orgID).Find(&rows).Error; err != nil {
		return nil, err
	}
	// «Tiene documentación» dejó de poder leerse de `body`.
	//
	// Desde que el texto vive en pestañas, un documento nuevo tiene el `body`
	// vacío y sólo la pestaña escrita: preguntar por `body` marcaba los viejos y
	// se saltaba todos los que se escriban a partir de ahora. Una consulta más,
	// agrupada, en vez de una por documento.
	conTexto := map[string]bool{}
	type fila struct {
		DocID string
		N     int64
	}
	var cuantas []fila
	r.db.Model(&domain.DocTab{}).
		Select("doc_id, count(*) as n").
		Where("doc_id IN (?) AND body <> ''", r.db.Model(&domain.Doc{}).Select("id").Where("org_id = ?", orgID)).
		Group("doc_id").Scan(&cuantas)
	for _, c := range cuantas {
		conTexto[c.DocID] = c.N > 0
	}

	ahora := time.Now()
	out := make(map[string]domain.DocMark, len(rows))
	for _, d := range rows {
		tiene := conTexto[d.ID] || d.Body != ""
		// Un documento sin una palabra escrita pero con responsable o con línea
		// fijada sigue siendo un documento: alguien lo reclamó. Esconderlo del
		// navegador sería esconder justo el estado que hay que arreglar.
		if !tiene && d.MaintainerID == "" && d.PinnedLine == "" {
			continue
		}
		out[string(d.OwnerKind)+":"+d.OwnerID] = domain.DocMark{
			Written:    tiene,
			PinnedLine: d.PinnedLine,
			Stale:      domain.DocIsStale(d.ReviewedAt, d.UpdatedAt, ahora),
		}
	}
	return out, nil
}

// AuthorName resolves the "last edited by" label. Kept in the repository next to
// the other SQL rather than adding a user dependency to the doc service.
func (r *DocRepository) AuthorName(userID string) string {
	if userID == "" {
		return ""
	}
	var name string
	r.db.Table("users").Select("COALESCE(username,'')").Where("id = ?", userID).Scan(&name)
	return name
}

func (r *DocRepository) Attachments(docID string) ([]domain.DocAttachment, error) {
	var out []domain.DocAttachment
	err := r.db.Where("doc_id = ?", docID).Order("created_at ASC").Find(&out).Error
	return out, err
}

func (r *DocRepository) CreateAttachment(a *domain.DocAttachment) error {
	return r.db.Create(a).Error
}

func (r *DocRepository) FindAttachment(id string) (*domain.DocAttachment, error) {
	var a domain.DocAttachment
	if err := r.db.First(&a, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &a, nil
}

func (r *DocRepository) DeleteAttachment(id string) error {
	return r.db.Delete(&domain.DocAttachment{}, "id = ?", id).Error
}

// Patch cambia los metadatos de un documento, creándolo si aún no había.
//
// Crear aquí por la misma razón que `SaveTab`: poner responsable a una lista que
// todavía no tiene documentación es una forma normal de empezar una —«esto es
// mío, ya lo escribiré»— y exigir que exista primero sólo traslada el problema
// a quien llame.
func (r *DocRepository) Patch(
	orgID string, kind domain.DocOwnerKind, ownerID string, fields map[string]any,
) (*domain.Doc, error) {
	doc, err := r.Find(kind, ownerID)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		doc = &domain.Doc{OrgID: orgID, OwnerKind: kind, OwnerID: ownerID}
		doc.ID = uuid.NewString()
		if err := r.db.Create(doc).Error; err != nil {
			return nil, err
		}
	}
	if len(fields) > 0 {
		// Mapa y no struct: quitar el responsable o vaciar la línea fijada son
		// valores cero, y con struct GORM los ignoraría — borrar dejaría de
		// funcionar sin que nada se queje.
		if err := r.db.Model(&domain.Doc{}).Where("id = ?", doc.ID).
			Updates(fields).Error; err != nil {
			return nil, err
		}
	}
	return r.FindByID(doc.ID)
}

// IsMember dice si alguien pertenece a una organización.
//
// Aquí y no llamando al repositorio de organizaciones para no atar los dos: lo
// único que hace falta es esta pregunta, y es una fila.
func (r *DocRepository) IsMember(orgID, userID string) bool {
	var n int64
	if err := r.db.Model(&domain.OrgMembership{}).
		Where("org_id = ? AND user_id = ?", orgID, userID).Count(&n).Error; err != nil {
		return false
	}
	return n > 0
}

// AddDecision apunta una decisión. No hay editar ni borrar: ver `Decision`.
//
// Si ya hay una escrita con ese mismo comentario, se devuelve la que había en
// vez de escribir otra. El registro no se puede podar, así que un reintento que
// dejara dos entradas idénticas las dejaría para siempre.
func (r *DocRepository) AddDecision(d *domain.Decision) (*domain.Decision, error) {
	if d.OriginCommentID != "" {
		var ya domain.Decision
		if err := r.db.Where("origin_comment_id = ?", d.OriginCommentID).First(&ya).Error; err == nil {
			return &ya, nil
		}
	}
	d.ID = uuid.NewString()
	if d.DecidedAt.IsZero() {
		d.DecidedAt = time.Now()
	}
	if err := r.db.Create(d).Error; err != nil {
		return nil, err
	}
	return d, nil
}

// Decisions: el registro de un documento, lo más reciente primero.
//
// El título de la tarea de origen se resuelve aquí: sin él, el enlace de vuelta
// sería un identificador, y nadie reconoce una tarea por su uuid.
func (r *DocRepository) Decisions(docID string) ([]domain.Decision, error) {
	var out []domain.Decision
	if err := r.db.Where("doc_id = ?", docID).
		Order("decided_at DESC").Find(&out).Error; err != nil {
		return nil, err
	}
	for i := range out {
		out[i].AuthorName = r.AuthorName(out[i].AuthorID)
		switch out[i].Origin {
		case domain.DecisionFromTask:
			r.db.Model(&domain.Task{}).Select("title").
				Where("id = ?", out[i].OriginTaskID).Scan(&out[i].OriginTitle)
		case domain.DecisionFromMessage:
			// Un canal **es** un espacio: el chat cuelga del espacio y no tiene
			// tabla propia (ver `ChatMessage.SpaceID`). El nombre que se pinta en
			// «en #Portento» es el del espacio.
			r.db.Model(&domain.TaskSpace{}).Select("name").
				Where("id = ?", out[i].OriginChannelID).Scan(&out[i].OriginTitle)
		}
	}
	return out, nil
}

// DocForList resuelve el documento de la lista a la que pertenece una tarea.
//
// Es lo que hace que una decisión tomada en una tarjeta aterrice en la
// documentación del proyecto sin que nadie tenga que copiarla: se decide donde
// se estaba trabajando y se guarda donde se va a buscar.
func (r *DocRepository) DocForList(listID string) (*domain.Doc, error) {
	return r.Find(domain.DocOwnerList, listID)
}
