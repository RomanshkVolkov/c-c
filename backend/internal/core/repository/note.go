package repository

import (
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

// Cycle detection lives in NoteService.MoveTree, which already has the whole
// tree loaded — the repository only applies what the service already validated.
var ErrNoteNotFound = errors.New("note not found")

type NoteRepository struct{ db *gorm.DB }

func NewNoteRepository(db *gorm.DB) *NoteRepository { return &NoteRepository{db: db} }

// Tree lists every page owned by the user, without bodies — the navigator's
// shape shouldn't get heavier as a page's content grows.
func (r *NoteRepository) Tree(ownerID string) ([]domain.NoteTreeItem, error) {
	var out []domain.NoteTreeItem
	err := r.db.Model(&domain.Note{}).
		Select("id, parent_id, position, title, favorite, body <> '' AS has_body").
		Where("owner_id = ?", ownerID).
		Order("position ASC").
		Find(&out).Error
	return out, err
}

func (r *NoteRepository) Create(n *domain.Note) error {
	n.ID = uuid.NewString()
	return r.db.Create(n).Error
}

// Find scopes by owner in the query itself — not just checked after the fact —
// so a mistake elsewhere can't accidentally leak another user's row.
func (r *NoteRepository) Find(id, ownerID string) (*domain.Note, error) {
	var n domain.Note
	err := r.db.Where("id = ? AND owner_id = ?", id, ownerID).First(&n).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNoteNotFound
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func (r *NoteRepository) CreateRevision(rev *domain.NoteRevision) error {
	rev.ID = uuid.NewString()
	return r.db.Create(rev).Error
}

func (r *NoteRepository) Update(id, ownerID string, fields map[string]any) error {
	res := r.db.Model(&domain.Note{}).Where("id = ? AND owner_id = ?", id, ownerID).Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNoteNotFound
	}
	return nil
}

// Descendants returns every id below (and including) the given one, computed
// with a recursive CTE — there are no foreign keys to cascade on, so the
// caller (the service) decides what "delete this page" means and the client
// gets to warn "this deletes N subpages" before confirming.
func (r *NoteRepository) Descendants(id, ownerID string) ([]string, error) {
	var ids []string
	// Raw SQL doesn't get GORM's soft-delete filter, so deleted_at is checked
	// by hand here — without it, deleting a page would re-delete pages already
	// sitting in the trash and reset how long they've been there.
	err := r.db.Raw(`
		WITH RECURSIVE sub AS (
			SELECT id FROM notes WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
			UNION ALL
			SELECT n.id FROM notes n JOIN sub ON n.parent_id = sub.id
			WHERE n.deleted_at IS NULL
		)
		SELECT id FROM sub
	`, id, ownerID).Scan(&ids).Error
	return ids, err
}

// TrashedDescendants is Descendants over the trash: the page and everything
// below it that is *also* trashed. Restoring uses it so a page comes back with
// the subpages that went down with it, rather than alone and childless.
func (r *NoteRepository) TrashedDescendants(id, ownerID string) ([]string, error) {
	var ids []string
	err := r.db.Raw(`
		WITH RECURSIVE sub AS (
			SELECT id FROM notes WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL
			UNION ALL
			SELECT n.id FROM notes n JOIN sub ON n.parent_id = sub.id
			WHERE n.deleted_at IS NOT NULL
		)
		SELECT id FROM sub
	`, id, ownerID).Scan(&ids).Error
	return ids, err
}

// Trash lists what's recoverable. Only the top of each deleted subtree is
// returned — deleting a page with ten subpages is one thing the user did, and
// showing it as eleven rows to restore individually would misrepresent it.
func (r *NoteRepository) Trash(ownerID string) ([]domain.NoteTrashItem, error) {
	var rows []domain.Note
	err := r.db.Unscoped().
		Where("owner_id = ? AND deleted_at IS NOT NULL", ownerID).
		Order("deleted_at DESC").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}

	trashed := make(map[string]bool, len(rows))
	for _, n := range rows {
		trashed[n.ID] = true
	}
	kids := make(map[string]int, len(rows))
	for _, n := range rows {
		if n.ParentID != nil && trashed[*n.ParentID] {
			kids[*n.ParentID]++
		}
	}

	out := []domain.NoteTrashItem{}
	for _, n := range rows {
		// A page whose parent is also in the trash went down with it; it comes
		// back with it too, so it isn't a separate entry.
		if n.ParentID != nil && trashed[*n.ParentID] {
			continue
		}
		count, err := r.TrashedDescendants(n.ID, ownerID)
		if err != nil {
			return nil, err
		}
		out = append(out, domain.NoteTrashItem{
			ID:        n.ID,
			Title:     n.Title,
			DeletedAt: n.DeletedAt.Time.Format(time.RFC3339),
			Subpages:  len(count) - 1, // the CTE counts the page itself
		})
	}
	return out, nil
}

// Restore un-deletes the given ids. `orphans` are those whose parent is gone or
// still trashed; they're sent back to the root so a restored page can never
// land somewhere invisible.
func (r *NoteRepository) Restore(ids []string, ownerID string, orphans []string) error {
	if len(ids) == 0 {
		return nil
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Model(&domain.Note{}).
			Where("id IN ? AND owner_id = ?", ids, ownerID).
			Update("deleted_at", nil).Error; err != nil {
			return err
		}
		if len(orphans) == 0 {
			return nil
		}
		return tx.Model(&domain.Note{}).
			Where("id IN ? AND owner_id = ?", orphans, ownerID).
			Update("parent_id", nil).Error
	})
}

// Purge deletes for real. Attachments go with it — their rows would otherwise
// point at a page that no longer exists.
func (r *NoteRepository) Purge(ids []string, ownerID string) error {
	if len(ids) == 0 {
		return nil
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("note_id IN ?", ids).
			Delete(&domain.NoteAttachment{}).Error; err != nil {
			return err
		}
		if err := tx.Where("note_id IN ?", ids).
			Delete(&domain.NoteRevision{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().
			Where("id IN ? AND owner_id = ?", ids, ownerID).
			Delete(&domain.Note{}).Error
	})
}

// TrashedIDs is every trashed page the user owns — what "empty the trash" acts
// on, and what tells Restore whether a parent is still in there.
func (r *NoteRepository) TrashedIDs(ownerID string) ([]string, error) {
	var ids []string
	err := r.db.Unscoped().Model(&domain.Note{}).
		Where("owner_id = ? AND deleted_at IS NOT NULL", ownerID).
		Pluck("id", &ids).Error
	return ids, err
}

// FindTrashed reads a page that is in the trash — the ordinary Find can't, by
// design, since every normal query pretends deleted pages don't exist.
func (r *NoteRepository) FindTrashed(id, ownerID string) (*domain.Note, error) {
	var n domain.Note
	err := r.db.Unscoped().
		Where("id = ? AND owner_id = ? AND deleted_at IS NOT NULL", id, ownerID).
		First(&n).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNoteNotFound
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func (r *NoteRepository) DeleteMany(ids []string, ownerID string) error {
	if len(ids) == 0 {
		return nil
	}
	return r.db.Where("id IN ? AND owner_id = ?", ids, ownerID).Delete(&domain.Note{}).Error
}

// ReplaceTree applies every page's new (parent, position) in one transaction.
// This is what makes moving a page and reordering siblings a single endpoint
// instead of four: the client already has the whole tree in memory (it just
// rendered it), so it computes the result and sends it back rather than the
// server exposing move/reorder primitives that could be called out of order.
func (r *NoteRepository) ReplaceTree(moves []domain.NoteTreeMove, ownerID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, m := range moves {
			res := tx.Model(&domain.Note{}).
				Where("id = ? AND owner_id = ?", m.ID, ownerID).
				Updates(map[string]any{"parent_id": m.ParentID, "position": m.Position})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return ErrNoteNotFound
			}
		}
		return nil
	})
}

// Search does substring matching, not full-text: "kube" has to find
// "kubernetes", which to_tsvector's stemmer would miss. At a few hundred
// personal notes a sequential scan costs milliseconds; the escape hatch if it
// ever doesn't is a trigram GIN index over this same ILIKE, not a rewrite.
func (r *NoteRepository) Search(ownerID, query string, limit int) ([]domain.NoteSearchResult, error) {
	terms := strings.Fields(query)
	if len(terms) == 0 {
		return []domain.NoteSearchResult{}, nil
	}
	q := r.db.Model(&domain.Note{}).Where("owner_id = ?", ownerID)
	for _, t := range terms {
		like := "%" + t + "%"
		q = q.Where("(title ILIKE ? OR body ILIKE ?)", like, like)
	}

	var rows []domain.Note
	// GORM's Order() takes a bare column/expression with no parameter binding,
	// so the title-first rank below is computed in Go instead of interpolating
	// the search term into SQL by hand.
	err := q.Select("id, title, body").
		Order("updated_at DESC").
		Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, err
	}

	first := strings.ToLower(terms[0])
	sort.SliceStable(rows, func(i, j int) bool {
		ti := strings.Contains(strings.ToLower(rows[i].Title), first)
		tj := strings.Contains(strings.ToLower(rows[j].Title), first)
		return ti && !tj
	})

	out := make([]domain.NoteSearchResult, len(rows))
	for i, n := range rows {
		out[i] = domain.NoteSearchResult{ID: n.ID, Title: n.Title, Excerpt: excerpt(n.Body, terms[0], 80)}
	}
	return out, nil
}

// excerpt centers a plain-text snippet on the first match, case-insensitive.
// Markdown syntax is left as-is (stripping it accurately needs a parser); good
// enough for a search result line.
func excerpt(body, term string, radius int) string {
	body = strings.TrimSpace(strings.ReplaceAll(body, "\n", " "))
	idx := strings.Index(strings.ToLower(body), strings.ToLower(term))
	if idx < 0 {
		if len(body) > radius*2 {
			return body[:radius*2] + "…"
		}
		return body
	}
	start := idx - radius
	prefix := ""
	if start < 0 {
		start = 0
	} else {
		prefix = "…"
	}
	end := idx + len(term) + radius
	suffix := ""
	if end >= len(body) {
		end = len(body)
	} else {
		suffix = "…"
	}
	return prefix + body[start:end] + suffix
}

// Backlinks finds notes whose body cites this one — a [Title](/notes/<id>)
// link, matched by the id substring rather than parsed markdown. Cheap and
// exact enough: a uuid is specific enough that a false match would require the
// id to appear in someone's prose by pure coincidence. Derived on every read,
// not stored, so a rename or an edit that removes the link can never leave a
// stale backlink behind.
func (r *NoteRepository) Backlinks(noteID, ownerID string) ([]domain.NoteSearchResult, error) {
	var rows []domain.Note
	err := r.db.Model(&domain.Note{}).
		Where("owner_id = ? AND id <> ? AND body LIKE ?", ownerID, noteID, "%"+noteID+"%").
		Select("id, title, body").
		Order("updated_at DESC").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make([]domain.NoteSearchResult, len(rows))
	for i, n := range rows {
		out[i] = domain.NoteSearchResult{ID: n.ID, Title: n.Title, Excerpt: excerpt(n.Body, noteID, 40)}
	}
	return out, nil
}

// All returns every page the user owns, bodies included — the export path.
// Ordered so a diff between two exports stays stable.
func (r *NoteRepository) All(ownerID string) ([]domain.Note, error) {
	var out []domain.Note
	err := r.db.Where("owner_id = ?", ownerID).
		Order("parent_id ASC NULLS FIRST, position ASC, created_at ASC").
		Find(&out).Error
	return out, err
}

// AttachmentsForOwner returns every attachment hanging off any of the user's
// pages, in one query — the export writes them all, and doing it per page would
// be one round trip per page for no benefit.
func (r *NoteRepository) AttachmentsForOwner(ownerID string) ([]domain.NoteAttachment, error) {
	var out []domain.NoteAttachment
	err := r.db.
		Where("note_id IN (?)", r.db.Model(&domain.Note{}).Select("id").Where("owner_id = ?", ownerID)).
		Order("created_at ASC").
		Find(&out).Error
	return out, err
}

func (r *NoteRepository) Attachments(noteID string) ([]domain.NoteAttachment, error) {
	var out []domain.NoteAttachment
	err := r.db.Where("note_id = ?", noteID).Order("created_at ASC").Find(&out).Error
	return out, err
}

func (r *NoteRepository) CreateAttachment(a *domain.NoteAttachment) error {
	a.ID = uuid.NewString()
	return r.db.Create(a).Error
}

func (r *NoteRepository) FindAttachment(id string) (*domain.NoteAttachment, error) {
	var a domain.NoteAttachment
	if err := r.db.First(&a, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &a, nil
}

func (r *NoteRepository) DeleteAttachment(id string) error {
	return r.db.Delete(&domain.NoteAttachment{}, "id = ?", id).Error
}
