package repository

import (
	"errors"

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

// HasDoc reports which of the given nodes carry a non-empty document, so the
// navigator can mark them without shipping every body.
func (r *DocRepository) HasDoc(orgID string) (map[string]bool, error) {
	var rows []domain.Doc
	if err := r.db.Select("owner_kind", "owner_id", "body").
		Where("org_id = ? AND body <> ''", orgID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(rows))
	for _, d := range rows {
		out[string(d.OwnerKind)+":"+d.OwnerID] = true
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
