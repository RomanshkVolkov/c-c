package service

import (
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

func (s *NoteService) Update(id, ownerID string, req domain.UpdateNoteRequest) (*domain.Note, error) {
	prev, err := s.repo.Find(id, ownerID)
	if err != nil {
		return nil, err
	}

	fields := map[string]any{}
	if req.Title != nil {
		fields["title"] = *req.Title
	}
	if req.Body != nil {
		fields["body"] = *req.Body
	}
	if len(fields) == 0 {
		return prev, nil
	}
	if err := s.repo.Update(id, ownerID, fields); err != nil {
		return nil, err
	}
	if req.Body != nil {
		s.dropRemovedAttachments(id, prev.Body, *req.Body)
	}
	return s.repo.Find(id, ownerID)
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
