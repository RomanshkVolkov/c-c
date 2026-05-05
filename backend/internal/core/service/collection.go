package service

import (
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// CollectionService implements all permission checks for the /collections API
// and translates between client-facing DTOs and persistence models.
type CollectionService struct {
	repo     *repository.CollectionRepository
	authRepo *repository.AuthRepository
}

func NewCollectionService(repo *repository.CollectionRepository, authRepo *repository.AuthRepository) *CollectionService {
	return &CollectionService{repo: repo, authRepo: authRepo}
}

// ─── Public API ──────────────────────────────────────────────────────────────

func (s *CollectionService) ListAccessible(userID string) ([]domain.CollectionListItem, error) {
	return s.repo.ListAccessibleByUser(userID)
}

func (s *CollectionService) Create(userID string, req domain.CreateCollectionRequest) (*domain.CollectionListItem, error) {
	c := &domain.Collection{
		OwnerID:     userID,
		Name:        req.Name,
		Description: req.Description,
	}
	c.ID = uuid.NewString()
	if err := s.repo.Create(c); err != nil {
		return nil, err
	}
	return s.repo.FindListItem(c.ID, userID)
}

func (s *CollectionService) Get(userID, id string) (*domain.CollectionDetailResponse, error) {
	perm, _, err := s.repo.GetUserPermission(id, userID)
	if err != nil {
		return nil, err
	}
	_ = perm // permission is used only for write paths; reads are allowed for any access

	item, err := s.repo.FindListItem(id, userID)
	if err != nil {
		return nil, err
	}
	nodes, err := s.repo.ListNodes(id)
	if err != nil {
		return nil, err
	}
	return &domain.CollectionDetailResponse{Collection: *item, Nodes: nodes}, nil
}

func (s *CollectionService) Update(userID, id string, req domain.UpdateCollectionRequest) (*domain.CollectionListItem, error) {
	if err := s.requireWrite(id, userID); err != nil {
		return nil, err
	}
	c, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	c.Name = req.Name
	c.Description = req.Description
	if err := s.repo.Update(c); err != nil {
		return nil, err
	}
	return s.repo.FindListItem(id, userID)
}

func (s *CollectionService) Delete(userID, id string) error {
	_, isOwner, err := s.repo.GetUserPermission(id, userID)
	if err != nil {
		return err
	}
	if !isOwner {
		return repository.ErrCollectionForbidden
	}
	return s.repo.Delete(id)
}

func (s *CollectionService) ReplaceTree(userID, id string, req domain.ReplaceTreeRequest) ([]domain.CollectionNode, error) {
	if err := s.requireWrite(id, userID); err != nil {
		return nil, err
	}
	nodes, err := buildNodes(id, req.Nodes)
	if err != nil {
		return nil, err
	}
	if err := s.repo.ReplaceNodes(id, nodes); err != nil {
		return nil, err
	}
	return s.repo.ListNodes(id)
}

func (s *CollectionService) ListShares(userID, id string) ([]domain.ShareInfo, error) {
	_, isOwner, err := s.repo.GetUserPermission(id, userID)
	if err != nil {
		return nil, err
	}
	if !isOwner {
		return nil, repository.ErrCollectionForbidden
	}
	return s.repo.ListShares(id)
}

func (s *CollectionService) Share(userID, id string, req domain.ShareCollectionRequest) (*domain.ShareInfo, error) {
	_, isOwner, err := s.repo.GetUserPermission(id, userID)
	if err != nil {
		return nil, err
	}
	if !isOwner {
		return nil, repository.ErrCollectionForbidden
	}
	target, err := s.authRepo.FindByUsername(req.Username)
	if err != nil {
		return nil, fmt.Errorf("user not found: %w", err)
	}
	if target.ID == userID {
		return nil, errors.New("cannot share a collection with yourself")
	}
	if err := s.repo.UpsertShare(id, target.ID, req.Permission); err != nil {
		return nil, err
	}
	return &domain.ShareInfo{
		UserID:     target.ID,
		Username:   target.Username,
		Permission: req.Permission,
	}, nil
}

func (s *CollectionService) Unshare(userID, id, targetUserID string) error {
	_, isOwner, err := s.repo.GetUserPermission(id, userID)
	if err != nil {
		return err
	}
	if !isOwner {
		return repository.ErrCollectionForbidden
	}
	return s.repo.DeleteShare(id, targetUserID)
}

// ─── Internal helpers ────────────────────────────────────────────────────────

func (s *CollectionService) requireWrite(collectionID, userID string) error {
	perm, _, err := s.repo.GetUserPermission(collectionID, userID)
	if err != nil {
		return err
	}
	if perm != domain.PermissionWrite {
		return repository.ErrCollectionForbidden
	}
	return nil
}

// buildNodes validates and transforms the inbound tree, assigning IDs where
// missing and rejecting parent references that don't resolve inside the same
// payload. ParentIDs that reference unknown ids are nil-ed out (treated as root)
// rather than failing the whole request.
func buildNodes(collectionID string, inputs []domain.CollectionNodeInput) ([]domain.CollectionNode, error) {
	ids := make(map[string]struct{}, len(inputs))
	for i := range inputs {
		if inputs[i].ID == "" {
			inputs[i].ID = uuid.NewString()
		}
		ids[inputs[i].ID] = struct{}{}
	}

	nodes := make([]domain.CollectionNode, len(inputs))
	for i, in := range inputs {
		var parent *string
		if in.ParentID != nil {
			if _, ok := ids[*in.ParentID]; ok {
				p := *in.ParentID
				parent = &p
			}
		}
		nodes[i] = domain.CollectionNode{
			ID:           in.ID,
			CollectionID: collectionID,
			ParentID:     parent,
			Type:         in.Type,
			Name:         in.Name,
			Position:     in.Position,
			Expanded:     in.Expanded,
			Method:       in.Method,
			URL:          in.URL,
			Headers:      in.Headers,
			Body:         in.Body,
		}
	}
	return nodes, nil
}
