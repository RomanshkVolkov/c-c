package domain

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"
)

// ─── JSON column type ─────────────────────────────────────────────────────────

type KeyValue struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// KeyValueList is persisted as JSON in a JSONB column.
type KeyValueList []KeyValue

func (k *KeyValueList) Scan(v any) error {
	if v == nil {
		*k = nil
		return nil
	}
	switch s := v.(type) {
	case []byte:
		return json.Unmarshal(s, k)
	case string:
		return json.Unmarshal([]byte(s), k)
	}
	return fmt.Errorf("KeyValueList: unsupported scan type %T", v)
}

func (k KeyValueList) Value() (driver.Value, error) {
	if k == nil {
		return "[]", nil
	}
	return json.Marshal(k)
}

// ─── Models ───────────────────────────────────────────────────────────────────

type Collection struct {
	BaseModel
	OwnerID     string `gorm:"type:varchar(36);index;not null" json:"ownerId"`
	Name        string `gorm:"type:varchar(200);not null"     json:"name"`
	Description string `gorm:"type:text"                      json:"description"`
}

type CollectionNodeType string

const (
	CollectionNodeFolder  CollectionNodeType = "folder"
	CollectionNodeRequest CollectionNodeType = "request"
)

type CollectionNode struct {
	ID           string             `gorm:"primaryKey;type:varchar(36)"        json:"id"`
	CollectionID string             `gorm:"type:varchar(36);index;not null"    json:"-"`
	ParentID     *string            `gorm:"type:varchar(36);index"             json:"parentId"`
	Type         CollectionNodeType `gorm:"type:varchar(20);not null"          json:"type"`
	Name         string             `gorm:"type:varchar(200);not null"         json:"name"`
	Position     int                `gorm:"not null;default:0"                 json:"position"`
	Expanded     bool               `gorm:"default:true"                       json:"expanded"`
	Method       string             `gorm:"type:varchar(20)"                   json:"method"`
	URL          string             `gorm:"type:text"                          json:"url"`
	Headers      KeyValueList       `gorm:"type:jsonb"                         json:"headers"`
	Body         string             `gorm:"type:text"                          json:"body"`
}

type CollectionPermission string

const (
	PermissionRead  CollectionPermission = "read"
	PermissionWrite CollectionPermission = "write"
)

type CollectionShare struct {
	BaseModel
	CollectionID     string               `gorm:"type:varchar(36);index;not null;uniqueIndex:idx_share_pair" json:"collectionId"`
	SharedWithUserID string               `gorm:"type:varchar(36);index;not null;uniqueIndex:idx_share_pair" json:"sharedWithUserId"`
	Permission       CollectionPermission `gorm:"type:varchar(20);not null"                                  json:"permission"`
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

type CreateCollectionRequest struct {
	Name        string `json:"name"        validate:"required,min=1,max=200"`
	Description string `json:"description" validate:"max=2000"`
}

type UpdateCollectionRequest struct {
	Name        string `json:"name"        validate:"required,min=1,max=200"`
	Description string `json:"description" validate:"max=2000"`
}

// CollectionNodeInput is what the client sends when replacing the tree.
type CollectionNodeInput struct {
	ID       string             `json:"id"`
	ParentID *string            `json:"parentId"`
	Type     CollectionNodeType `json:"type"     validate:"required,oneof=folder request"`
	Name     string             `json:"name"     validate:"required,min=1,max=200"`
	Position int                `json:"position"`
	Expanded bool               `json:"expanded"`
	Method   string             `json:"method"`
	URL      string             `json:"url"`
	Headers  KeyValueList       `json:"headers"`
	Body     string             `json:"body"`
}

type ReplaceTreeRequest struct {
	Nodes []CollectionNodeInput `json:"nodes" validate:"dive"`
}

type CollectionListItem struct {
	ID          string               `json:"id"          gorm:"column:id"`
	Name        string               `json:"name"        gorm:"column:name"`
	Description string               `json:"description" gorm:"column:description"`
	OwnerID     string               `json:"ownerId"     gorm:"column:owner_id"`
	OwnerName   string               `json:"ownerName"   gorm:"column:owner_name"`
	Permission  CollectionPermission `json:"permission"  gorm:"column:permission"`
	IsOwner     bool                 `json:"isOwner"     gorm:"column:is_owner"`
	UpdatedAt   time.Time            `json:"updatedAt"   gorm:"column:updated_at"`
}

type CollectionDetailResponse struct {
	Collection CollectionListItem `json:"collection"`
	Nodes      []CollectionNode   `json:"nodes"`
}

type ShareCollectionRequest struct {
	Username   string               `json:"username"   validate:"required"`
	Permission CollectionPermission `json:"permission" validate:"required,oneof=read write"`
}

type ShareInfo struct {
	UserID     string               `json:"userId"     gorm:"column:user_id"`
	Username   string               `json:"username"   gorm:"column:username"`
	Permission CollectionPermission `json:"permission" gorm:"column:permission"`
}

type UserSummary struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}
