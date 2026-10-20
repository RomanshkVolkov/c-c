package repository

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	// ErrLinkInvalid: el enlace no existe, ya se usó o caducó. Las tres cosas
	// se contestan igual: distinguirlas sólo le sirve a quien prueba tokens.
	ErrLinkInvalid = errors.New("account link is invalid")
	ErrEmailTaken  = errors.New("email already in use")
)

// HashAccountLink: el HMAC de un token de enlace. Con su propio prefijo, como
// los demás (`pat:`, `deploy:`), para que el hash de un tipo de token nunca
// valga como el de otro.
func HashAccountLink(plain string) []byte {
	mac := hmac.New(sha256.New, ingestSecret())
	mac.Write([]byte("account-link:" + plain))
	return mac.Sum(nil)
}

// GenerateAccountLink: un token aleatorio de 32 bytes, y su hash.
func GenerateAccountLink() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("failed to generate account link: %w", err)
	}
	plain := base64.RawURLEncoding.EncodeToString(raw)
	return plain, HashAccountLink(plain), nil
}

// NormalizeEmail: como se compara un correo. Sin espacios y en minúsculas: la
// parte local distingue mayúsculas según el estándar, pero ningún proveedor
// real lo hace, y dos cuentas para `Ana@x` y `ana@x` serían la misma persona.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// EnsureUserIndexes: un correo, una cuenta. Parcial porque hay cuentas sin
// correo (las de antes de que se pidiera), y sobre `lower()` porque así se
// compara (NormalizeEmail). Con el índice, dos altas a la vez del mismo correo
// chocan en la base y no en una comprobación previa que no ve a la otra.
func EnsureUserIndexes(db *gorm.DB) error {
	return db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
		ON users (lower(email)) WHERE email <> ''`).Error
}

type AccountRepository struct{ db *gorm.DB }

func NewAccountRepository(db *gorm.DB) *AccountRepository { return &AccountRepository{db: db} }

// FindByEmail: la cuenta de un correo, comparado como NormalizeEmail.
func (r *AccountRepository) FindByEmail(email string) (*domain.User, error) {
	var u domain.User
	err := r.db.Where("lower(email) = ? AND email <> ''", NormalizeEmail(email)).First(&u).Error
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// FindByLogin: la cuenta de un usuario o de un correo, lo que la persona
// recuerde. El usuario se mira primero: es único siempre, el correo no en las
// cuentas viejas sin él.
func (r *AccountRepository) FindByLogin(login string) (*domain.User, error) {
	login = strings.TrimSpace(login)
	var u domain.User
	err := r.db.Where("username = ?", login).First(&u).Error
	if err == nil {
		return &u, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	return r.FindByEmail(login)
}

// CreatePendingMember crea la cuenta pendiente y la hace miembro de la
// organización, en una transacción: una cuenta sin organización no la vería
// nadie para reenviarle el enlace.
func (r *AccountRepository) CreatePendingMember(u *domain.User, orgID string, role domain.OrgRole) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(u).Error; err != nil {
			if isUniqueViolation(err) {
				return ErrEmailTaken
			}
			return err
		}
		return tx.Create(&domain.OrgMembership{OrgID: orgID, UserID: u.ID, Role: role}).Error
	})
}

// AddMember hace miembro a alguien de una organización si aún no lo es.
func (r *AccountRepository) AddMember(orgID, userID string, role domain.OrgRole) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).
		Create(&domain.OrgMembership{OrgID: orgID, UserID: userID, Role: role}).Error
}

// CreateLink guarda un enlace nuevo y da por usados los anteriores de la misma
// persona y el mismo propósito: el último correo es el único que vale.
func (r *AccountRepository) CreateLink(l *domain.AccountLink, now time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&domain.AccountLink{}).
			Where("user_id = ? AND purpose = ? AND used_at IS NULL", l.UserID, l.Purpose).
			Update("used_at", now).Error; err != nil {
			return err
		}
		if l.ID == "" {
			l.ID = uuid.NewString()
		}
		return tx.Create(l).Error
	})
}

// FindLink: un enlace vivo (sin usar y sin caducar) de ese propósito.
func (r *AccountRepository) FindLink(plain, purpose string, now time.Time) (*domain.AccountLink, error) {
	var l domain.AccountLink
	err := r.db.Where("token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?",
		HashAccountLink(plain), purpose, now).First(&l).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrLinkInvalid
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// UseLink gasta un enlace y aplica lo que trae, en una transacción: o las dos
// cosas, o ninguna. La fila se bloquea antes de mirarla, así que dos clics al
// mismo enlace no lo usan dos veces; y si `apply` falla (el usuario elegido ya
// existe), el enlace sigue vivo para intentarlo con otro.
func (r *AccountRepository) UseLink(plain, purpose string, now time.Time, apply func(tx *gorm.DB, l *domain.AccountLink) error) (*domain.AccountLink, error) {
	var l domain.AccountLink
	err := r.db.Transaction(func(tx *gorm.DB) error {
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?",
				HashAccountLink(plain), purpose, now).
			First(&l).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrLinkInvalid
		}
		if err != nil {
			return err
		}
		if err := apply(tx, &l); err != nil {
			return err
		}
		return tx.Model(&domain.AccountLink{}).Where("id = ?", l.ID).Update("used_at", now).Error
	})
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// PruneLinks borra los enlaces que ya no valen y llevan un mes así: lo que
// queda de un enlace usado no sirve más que para saber cuándo se usó.
func (r *AccountRepository) PruneLinks(now time.Time) error {
	cutoff := now.Add(-30 * 24 * time.Hour)
	return r.db.Where("expires_at < ? OR used_at < ?", cutoff, cutoff).Delete(&domain.AccountLink{}).Error
}

// UsernameTaken: si un usuario ya existe, dentro de la transacción del enlace.
func UsernameTaken(tx *gorm.DB, username, exceptID string) (bool, error) {
	var n int64
	err := tx.Model(&domain.User{}).Where("lower(username) = lower(?) AND id <> ?", username, exceptID).Count(&n).Error
	return n > 0, err
}

// IsUniqueViolation: si un error de la base es un índice único que chocó.
func IsUniqueViolation(err error) bool { return isUniqueViolation(err) }
