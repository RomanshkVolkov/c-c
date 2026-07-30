package service

import (
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type DocService struct {
	repo *repository.DocRepository
}

func NewDocService(repo *repository.DocRepository) *DocService {
	return &DocService{repo: repo}
}

func (s *DocService) OwnerOrg(kind domain.DocOwnerKind, id string) (string, error) {
	return s.repo.OwnerOrg(kind, id)
}

// Get returns the node's document. Never an error for "not written yet": an
// empty overview is the normal starting state, and the caller renders the same
// editor either way.
func (s *DocService) Get(kind domain.DocOwnerKind, id string) (*domain.Doc, error) {
	d, err := s.repo.Find(kind, id)
	if err != nil || d == nil {
		return nil, err
	}
	s.stampAuthor(d)
	return d, nil
}

func (s *DocService) Save(orgID string, kind domain.DocOwnerKind, id, body, userID string) (*domain.Doc, error) {
	before := ""
	if prev, err := s.repo.Find(kind, id); err == nil && prev != nil {
		before = prev.Body
	}
	d, err := s.repo.Save(orgID, kind, id, body, userID)
	if err != nil {
		return nil, err
	}
	s.dropRemovedAttachments(d.ID, before, body)
	s.stampAuthor(d)
	return d, nil
}

func (s *DocService) HasDoc(orgID string) (map[string]bool, error) { return s.repo.HasDoc(orgID) }

func (s *DocService) FindByID(id string) (*domain.Doc, error) { return s.repo.FindByID(id) }

func (s *DocService) Attachments(docID string) ([]domain.DocAttachment, error) {
	atts, err := s.repo.Attachments(docID)
	if err != nil {
		return nil, err
	}
	for i := range atts {
		atts[i].NormalizeURL()
	}
	return atts, nil
}

func (s *DocService) AddAttachment(a *domain.DocAttachment) error {
	return s.repo.CreateAttachment(a)
}

func (s *DocService) FindAttachment(id string) (*domain.DocAttachment, error) {
	return s.repo.FindAttachment(id)
}

func (s *DocService) DeleteAttachment(id string) error { return s.repo.DeleteAttachment(id) }

// dropRemovedAttachments mirrors the task rule: a file stops being listed when
// the reference the user just deleted was in the previous text and is gone from
// the new one. Narrow on purpose — pruning everything unreferenced would delete
// an image pasted seconds ago that hasn't been saved into any text yet.
func (s *DocService) dropRemovedAttachments(docID, before, after string) {
	if before == "" || before == after {
		return
	}
	atts, err := s.repo.Attachments(docID)
	if err != nil {
		return
	}
	for _, a := range atts {
		if !strings.Contains(before, a.ID) || strings.Contains(after, a.ID) {
			continue
		}
		if err := s.repo.DeleteAttachment(a.ID); err != nil {
			lg.Error("drop removed doc attachment " + a.ID + ": " + err.Error())
		}
	}
}

// stampAuthor fills the display name for "last edited by", which the row only
// stores as an id.
func (s *DocService) stampAuthor(d *domain.Doc) {
	d.UpdatedByName = s.repo.AuthorName(d.UpdatedBy)
}
