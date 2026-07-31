package repository

import (
	"errors"
	"sort"
	"strings"

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
		Select("id, parent_id, position, title, body <> '' AS has_body").
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
	err := r.db.Raw(`
		WITH RECURSIVE sub AS (
			SELECT id FROM notes WHERE id = ? AND owner_id = ?
			UNION ALL
			SELECT n.id FROM notes n JOIN sub ON n.parent_id = sub.id
		)
		SELECT id FROM sub
	`, id, ownerID).Scan(&ids).Error
	return ids, err
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
