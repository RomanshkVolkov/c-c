package repository

import (
	"errors"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

var (
	ErrCollectionNotFound = errors.New("collection not found")
	ErrShareNotFound      = errors.New("share not found")
	ErrCollectionForbidden = errors.New("forbidden")
)

type CollectionRepository struct {
	db *gorm.DB
}

func NewCollectionRepository(db *gorm.DB) *CollectionRepository {
	return &CollectionRepository{db: db}
}

// ListAccessibleByUser returns collections owned by the user plus those shared
// with them. Each row carries the user's effective permission ("write" for the
// owner; the share row's permission for a shared collection) and the owner's
// username, so the frontend can render the sidebar in one round-trip.
func (r *CollectionRepository) ListAccessibleByUser(userID string) ([]domain.CollectionListItem, error) {
	var items []domain.CollectionListItem
	err := r.db.Raw(`
		SELECT c.id, c.name, c.description, c.owner_id,
		       u.username AS owner_name,
		       'write' AS permission,
		       true AS is_owner,
		       c.updated_at
		FROM collections c
		JOIN users u ON u.id = c.owner_id
		WHERE c.owner_id = ?
		UNION ALL
		SELECT c.id, c.name, c.description, c.owner_id,
		       u.username AS owner_name,
		       s.permission,
		       false AS is_owner,
		       c.updated_at
		FROM collections c
		JOIN users u ON u.id = c.owner_id
		JOIN collection_shares s ON s.collection_id = c.id
		WHERE s.shared_with_user_id = ?
		ORDER BY updated_at DESC
	`, userID, userID).Scan(&items).Error
	return items, err
}

func (r *CollectionRepository) FindByID(id string) (*domain.Collection, error) {
	var c domain.Collection
	if err := r.db.First(&c, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCollectionNotFound
		}
		return nil, err
	}
	return &c, nil
}

func (r *CollectionRepository) FindListItem(id, userID string) (*domain.CollectionListItem, error) {
	var item domain.CollectionListItem
	err := r.db.Raw(`
		SELECT c.id, c.name, c.description, c.owner_id,
		       u.username AS owner_name,
		       CASE WHEN c.owner_id = ? THEN 'write' ELSE COALESCE(s.permission, '') END AS permission,
		       (c.owner_id = ?) AS is_owner,
		       c.updated_at
		FROM collections c
		JOIN users u ON u.id = c.owner_id
		LEFT JOIN collection_shares s
		       ON s.collection_id = c.id AND s.shared_with_user_id = ?
		WHERE c.id = ?
	`, userID, userID, userID, id).Scan(&item).Error
	if err != nil {
		return nil, err
	}
	if item.ID == "" {
		return nil, ErrCollectionNotFound
	}
	return &item, nil
}

func (r *CollectionRepository) Create(c *domain.Collection) error {
	return r.db.Create(c).Error
}

func (r *CollectionRepository) Update(c *domain.Collection) error {
	return r.db.Save(c).Error
}

func (r *CollectionRepository) Delete(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("collection_id = ?", id).Delete(&domain.CollectionNode{}).Error; err != nil {
			return err
		}
		if err := tx.Where("collection_id = ?", id).Delete(&domain.CollectionShare{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.Collection{}, "id = ?", id).Error
	})
}

func (r *CollectionRepository) ListNodes(collectionID string) ([]domain.CollectionNode, error) {
	var nodes []domain.CollectionNode
	err := r.db.
		Where("collection_id = ?", collectionID).
		Order("position ASC").
		Find(&nodes).Error
	return nodes, err
}

// ReplaceNodes wipes and recreates the entire tree atomically and bumps the
// collection's updated_at so list ordering reflects activity.
func (r *CollectionRepository) ReplaceNodes(collectionID string, nodes []domain.CollectionNode) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("collection_id = ?", collectionID).Delete(&domain.CollectionNode{}).Error; err != nil {
			return err
		}
		if len(nodes) > 0 {
			if err := tx.Create(&nodes).Error; err != nil {
				return err
			}
		}
		return tx.Model(&domain.Collection{}).
			Where("id = ?", collectionID).
			Update("updated_at", gorm.Expr("NOW()")).Error
	})
}

// GetUserPermission returns the effective permission for a user against a
// collection. Owner always gets PermissionWrite. Returns ErrCollectionForbidden
// when the user has no access at all.
func (r *CollectionRepository) GetUserPermission(collectionID, userID string) (domain.CollectionPermission, bool, error) {
	var c domain.Collection
	if err := r.db.Select("id, owner_id").First(&c, "id = ?", collectionID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", false, ErrCollectionNotFound
		}
		return "", false, err
	}
	if c.OwnerID == userID {
		return domain.PermissionWrite, true, nil
	}
	var share domain.CollectionShare
	err := r.db.
		Where("collection_id = ? AND shared_with_user_id = ?", collectionID, userID).
		First(&share).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, ErrCollectionForbidden
	}
	if err != nil {
		return "", false, err
	}
	return share.Permission, false, nil
}

func (r *CollectionRepository) ListShares(collectionID string) ([]domain.ShareInfo, error) {
	var rows []domain.ShareInfo
	err := r.db.Raw(`
		SELECT s.shared_with_user_id AS user_id, u.username, s.permission
		FROM collection_shares s
		JOIN users u ON u.id = s.shared_with_user_id
		WHERE s.collection_id = ?
		ORDER BY u.username ASC
	`, collectionID).Scan(&rows).Error
	return rows, err
}

func (r *CollectionRepository) UpsertShare(collectionID, userID string, permission domain.CollectionPermission) error {
	var existing domain.CollectionShare
	err := r.db.
		Where("collection_id = ? AND shared_with_user_id = ?", collectionID, userID).
		First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return r.db.Create(&domain.CollectionShare{
			CollectionID:     collectionID,
			SharedWithUserID: userID,
			Permission:       permission,
		}).Error
	}
	if err != nil {
		return err
	}
	return r.db.Model(&existing).Update("permission", permission).Error
}

func (r *CollectionRepository) DeleteShare(collectionID, userID string) error {
	res := r.db.
		Where("collection_id = ? AND shared_with_user_id = ?", collectionID, userID).
		Delete(&domain.CollectionShare{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrShareNotFound
	}
	return nil
}
