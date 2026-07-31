package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var ErrNoteCycle = errors.New("a page can't become its own descendant's child")

type NoteService struct {
	repo *repository.NoteRepository
}

func NewNoteService(repo *repository.NoteRepository) *NoteService {
	return &NoteService{repo: repo}
}

func (s *NoteService) Tree(ownerID string) ([]domain.NoteTreeItem, error) {
	return s.repo.Tree(ownerID)
}

func (s *NoteService) Get(id, ownerID string) (*domain.Note, error) {
	return s.repo.Find(id, ownerID)
}

func (s *NoteService) Create(ownerID string, req domain.CreateNoteRequest) (*domain.Note, error) {
	n := &domain.Note{OwnerID: ownerID, ParentID: req.ParentID, Title: req.Title}
	if err := s.repo.Create(n); err != nil {
		return nil, err
	}
	return n, nil
}

func (s *NoteService) Update(id, ownerID string, req domain.UpdateNoteRequest) (*domain.UpdateNoteResult, error) {
	prev, err := s.repo.Find(id, ownerID)
	if err != nil {
		return nil, err
	}

	// A body save carries the hash this device last saw. If the server's
	// current hash has since moved, another device (or a queued offline write)
	// saved first — applying this one anyway would silently discard that edit.
	// `prev` was just read fresh, so its hash IS the current winner's.
	//
	// Gated on prev.BodyHash, not req.BaseHash: a note with no hash yet (never
	// saved by anyone, or written before this check existed) has nothing to
	// compare against and can't produce a false conflict. But once the server
	// DOES have a real hash, a client sending an empty baseHash is exactly as
	// stale as one sending a wrong one — its cached copy predates the first
	// hash ever written, which is still a version it never saw.
	if req.Body != nil && prev.BodyHash != "" &&
		(req.BaseHash == nil || *req.BaseHash != prev.BodyHash) {
		conflict := &domain.Note{
			OwnerID:  ownerID,
			ParentID: &prev.ID,
			Title:    conflictTitle(prev.Title),
			Body:     *req.Body,
			BodyHash: hashBody(*req.Body),
		}
		if err := s.repo.Create(conflict); err != nil {
			return nil, err
		}
		return &domain.UpdateNoteResult{
			Note:     prev,
			Conflict: &domain.NoteConflictInfo{ID: conflict.ID, Title: conflict.Title},
		}, nil
	}

	fields := map[string]any{}
	if req.Title != nil {
		fields["title"] = *req.Title
	}
	if req.Body != nil {
		// The pre-image is kept even for an uncontested save: a revision isn't
		// only for resolving conflicts, it's the guarantee that no save is ever
		// the last copy of whatever text came before it.
		if err := s.repo.CreateRevision(&domain.NoteRevision{
			NoteID: id, OwnerID: ownerID, Title: prev.Title, Body: prev.Body,
		}); err != nil {
			lg.Error("note revision snapshot for " + id + ": " + err.Error())
		}
		fields["body"] = *req.Body
		fields["body_hash"] = hashBody(*req.Body)
	}
	if len(fields) == 0 {
		return &domain.UpdateNoteResult{Note: prev}, nil
	}
	if err := s.repo.Update(id, ownerID, fields); err != nil {
		return nil, err
	}
	if req.Body != nil {
		s.dropRemovedAttachments(id, prev.Body, *req.Body)
	}
	updated, err := s.repo.Find(id, ownerID)
	if err != nil {
		return nil, err
	}
	return &domain.UpdateNoteResult{Note: updated}, nil
}

func hashBody(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

func conflictTitle(base string) string {
	if base == "" {
		base = "Untitled"
	}
	return base + " (conflicting edit)"
}

// Delete removes a page and every page below it. There are no foreign keys to
// cascade on, so the caller must already know (and have shown the user) which
// ids that is — see Descendants.
func (s *NoteService) Delete(id, ownerID string) error {
	ids, err := s.repo.Descendants(id, ownerID)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return repository.ErrNoteNotFound
	}
	return s.repo.DeleteMany(ids, ownerID)
}

// Descendants is exposed so the handler can tell the client "this deletes N
// subpages" before they confirm, instead of surprising them after the fact.
func (s *NoteService) Descendants(id, ownerID string) ([]string, error) {
	return s.repo.Descendants(id, ownerID)
}

// MoveTree validates the whole batch before writing any of it: a client bug
// that tried to drop a page inside its own descendant would otherwise corrupt
// the tree one row at a time with no way to detect it after the fact.
func (s *NoteService) MoveTree(moves []domain.NoteTreeMove, ownerID string) error {
	tree, err := s.repo.Tree(ownerID)
	if err != nil {
		return err
	}
	parentOf := make(map[string]*string, len(tree))
	for _, n := range tree {
		parentOf[n.ID] = n.ParentID
	}
	// Apply the proposed parents on top of the current tree before checking:
	// two moves in the same batch can each be fine alone but form a cycle
	// together (A becomes a child of B while B becomes a child of A).
	for _, m := range moves {
		pid := m.ParentID
		parentOf[m.ID] = pid
	}
	for _, m := range moves {
		if m.ParentID == nil {
			continue
		}
		for cur := m.ParentID; cur != nil; {
			if *cur == m.ID {
				return ErrNoteCycle
			}
			cur = parentOf[*cur]
		}
	}
	return s.repo.ReplaceTree(moves, ownerID)
}

func (s *NoteService) Search(ownerID, query string, limit int) ([]domain.NoteSearchResult, error) {
	if limit <= 0 || limit > 100 {
		limit = 40
	}
	return s.repo.Search(ownerID, query, limit)
}

func (s *NoteService) Backlinks(noteID, ownerID string) ([]domain.NoteSearchResult, error) {
	return s.repo.Backlinks(noteID, ownerID)
}

func (s *NoteService) Attachments(noteID string) ([]domain.NoteAttachment, error) {
	atts, err := s.repo.Attachments(noteID)
	if err != nil {
		return nil, err
	}
	for i := range atts {
		atts[i].NormalizeURL()
	}
	return atts, nil
}

func (s *NoteService) AddAttachment(a *domain.NoteAttachment) error {
	return s.repo.CreateAttachment(a)
}

func (s *NoteService) FindAttachment(id string) (*domain.NoteAttachment, error) {
	return s.repo.FindAttachment(id)
}

func (s *NoteService) DeleteAttachment(id string) error { return s.repo.DeleteAttachment(id) }

// dropRemovedAttachments mirrors the task/doc rule: a file stops being listed
// only when the reference the user just deleted was in the previous text and
// is gone from the new one. Narrow on purpose — pruning everything
// unreferenced would delete an image pasted seconds ago that hasn't been
// saved into any text yet.
func (s *NoteService) dropRemovedAttachments(noteID, before, after string) {
	if before == "" || before == after {
		return
	}
	atts, err := s.repo.Attachments(noteID)
	if err != nil {
		return
	}
	for _, a := range atts {
		if !strings.Contains(before, a.ID) || strings.Contains(after, a.ID) {
			continue
		}
		if err := s.repo.DeleteAttachment(a.ID); err != nil {
			lg.Error("drop removed note attachment " + a.ID + ": " + err.Error())
		}
	}
}
