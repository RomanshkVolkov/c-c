package repository

import (
	"errors"
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
	// `Updates` con mapa y no con struct: con struct, un cuerpo vaciado a
	// propósito es el valor cero y GORM no lo escribiría — vaciar una sección
	// dejaría de funcionar sin que nada se queje.
	if err := r.db.Model(&domain.DocTab{}).Where("id = ?", existente.ID).
		Updates(map[string]any{"body": body, "updated_by": userID}).Error; err != nil {
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
