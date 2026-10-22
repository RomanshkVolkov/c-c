package repository

import (
	"errors"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// La clave de un espacio (domain/space_key.go): única en la org, frente a las
// de los otros espacios —también las que tuvieron antes— y a los slugs de los
// proyectos de cliente, que se nombran igual (`acme-7`).

var (
	ErrSpaceKeyInvalid = errors.New("space-key-invalid")
	ErrSpaceKeyTaken   = errors.New("space-key-taken")
)

// SpaceKeyTaken: si `key` ya la usa en la org otro espacio que no sea
// `exceptSpaceID` (ahora o antes), o un proyecto de cliente.
func (r *TaskRepository) SpaceKeyTaken(orgID, key, exceptSpaceID string) bool {
	return spaceKeyTaken(r.db, orgID, key, exceptSpaceID)
}

func spaceKeyTaken(db *gorm.DB, orgID, key, exceptSpaceID string) bool {
	var n int64
	db.Model(&domain.TaskSpace{}).Where("org_id = ? AND key = ? AND id <> ?", orgID, key, exceptSpaceID).Count(&n)
	if n > 0 {
		return true
	}
	db.Model(&domain.SpaceKeyAlias{}).Where("org_id = ? AND key = ? AND space_id <> ?", orgID, key, exceptSpaceID).Count(&n)
	if n > 0 {
		return true
	}
	if db.Migrator().HasTable("report_projects") {
		db.Table("report_projects").Where("org_id = ? AND slug = ?", orgID, key).Count(&n)
	}
	return n > 0
}

// assignSpaceKey le pone su clave a un espacio que no la tiene, sacada de su
// nombre. La sala general no lleva: no tiene tareas que nombrar.
func assignSpaceKey(db *gorm.DB, s *domain.TaskSpace) {
	if s.Key != "" || s.Kind == domain.SpaceKindGeneral {
		return
	}
	s.Key = domain.FreeSpaceKey(domain.SpaceKeyFrom(s.Name), func(k string) bool {
		return spaceKeyTaken(db, s.OrgID, k, s.ID)
	})
}

// ChangeSpaceKey cambia la clave de un espacio a mano. La vieja queda como
// alias, así que lo que ya la citaba sigue enlazando.
func (r *TaskRepository) ChangeSpaceKey(spaceID, key string) error {
	if !domain.ValidSpaceKey(key) {
		return ErrSpaceKeyInvalid
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		var sp domain.TaskSpace
		if err := tx.First(&sp, "id = ?", spaceID).Error; err != nil {
			return ErrSpaceNotFound
		}
		if sp.Key == key {
			return nil
		}
		if spaceKeyTaken(tx, sp.OrgID, key, sp.ID) {
			return ErrSpaceKeyTaken
		}
		if sp.Key != "" {
			if err := tx.Create(&domain.SpaceKeyAlias{ID: uuid.NewString(), OrgID: sp.OrgID, SpaceID: sp.ID, Key: sp.Key}).Error; err != nil {
				return err
			}
		}
		// Si vuelve a una clave que ya tuvo, deja de ser un alias.
		if err := tx.Where("space_id = ? AND key = ?", sp.ID, key).Delete(&domain.SpaceKeyAlias{}).Error; err != nil {
			return err
		}
		return tx.Model(&domain.TaskSpace{}).Where("id = ?", sp.ID).Update("key", key).Error
	})
}

// findSpaceByKey: el espacio de la org con esa clave, ahora o antes.
func findSpaceByKey(db *gorm.DB, orgID, key string) (*domain.TaskSpace, error) {
	var sp domain.TaskSpace
	if err := db.First(&sp, "org_id = ? AND key = ?", orgID, key).Error; err == nil {
		return &sp, nil
	}
	var a domain.SpaceKeyAlias
	if err := db.First(&a, "org_id = ? AND key = ?", orgID, key).Error; err != nil {
		return nil, ErrSpaceNotFound
	}
	if err := db.First(&sp, "id = ?", a.SpaceID).Error; err != nil {
		return nil, ErrSpaceNotFound
	}
	return &sp, nil
}

// backfillSpaceKeys les pone clave a los espacios que no la tienen, en el
// orden en que se crearon: si dos se llaman igual, el más viejo se queda la
// clave sin letra. Idempotente: al arrancar, y desde las bases de prueba.
func backfillSpaceKeys(db *gorm.DB) {
	if !db.Migrator().HasColumn(&domain.TaskSpace{}, "key") {
		return
	}
	var spaces []domain.TaskSpace
	if err := db.Where("(key IS NULL OR key = '') AND (kind IS NULL OR kind <> ?)", domain.SpaceKindGeneral).
		Order("created_at ASC").Find(&spaces).Error; err != nil {
		lg.Warn("space keys: " + err.Error())
		return
	}
	for i := range spaces {
		s := &spaces[i]
		assignSpaceKey(db, s)
		if err := db.Model(&domain.TaskSpace{}).Where("id = ?", s.ID).Update("key", s.Key).Error; err != nil {
			lg.Warn("space keys: " + s.ID + ": " + err.Error())
		}
	}
	// Una clave por org, también con dos réplicas creando espacios a la vez.
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_spaces_org_key
		ON task_spaces (org_id, key) WHERE key <> ''`).Error; err != nil && !strings.Contains(err.Error(), "already exists") {
		lg.Warn("space keys index: " + err.Error())
	}
}
