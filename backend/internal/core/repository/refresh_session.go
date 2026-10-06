package repository

import (
	"errors"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrRefreshRevoked: un refresh que ya no vale —cerrado, o de una familia que
// se dio por robada—. Es un código y no una frase: la app lo trata como
// cualquier otro 401 y vuelve a pedir que entres.
var ErrRefreshRevoked = errors.New("revoked-token")

// SaveRefresh apunta un refresh recién emitido. `familyID` vacío abre una
// familia nueva (un login); si no, continúa la de quien lo canjeó.
func (r *AuthRepository) SaveRefresh(userID, familyID string, pair *domain.TokenPair) error {
	if familyID == "" {
		familyID = pair.RefreshID
	}
	return r.db.Create(&domain.RefreshSession{
		ID: pair.RefreshID, UserID: userID, FamilyID: familyID, ExpiresAt: pair.RefreshExpiresAt,
	}).Error
}

// ClaimRefresh canjea un refresh: lo marca rotado y devuelve su familia, para
// que el siguiente siga en ella. Las reglas, en orden:
//
//   - **No está apuntado**: es de antes de que existiera la tabla. Se adopta
//     —se apunta ya rotado, como cabeza de una familia nueva— en vez de echar
//     a todo el mundo el día del despliegue. Su firma ya se comprobó.
//   - **Revocado**: no vale.
//   - **Vigente**: se rota.
//   - **Rotado hace menos de `RefreshReuseGrace`**: vale otra vez. Es la carrera
//     de dos peticiones con el mismo token, no un robo.
//   - **Rotado hace más**: alguien tiene una copia. Se revoca la familia entera.
//
// Todo en una transacción con la fila bloqueada: dos canjes simultáneos se
// ordenan, y el segundo ve lo que dejó el primero.
func (r *AuthRepository) ClaimRefresh(claims *domain.ClaimsRefresh, now time.Time) (familyID string, err error) {
	// stolen: la familia se revocó en esta transacción. Una bandera y no un
	// error devuelto desde dentro, porque eso **desharía** la revocación: el
	// ladrón se quedaría sin respuesta y la familia seguiría viva.
	stolen := false
	err = r.db.Transaction(func(tx *gorm.DB) error {
		var s domain.RefreshSession
		e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&s, "id = ?", claims.TokenID).Error
		if errors.Is(e, gorm.ErrRecordNotFound) {
			exp := now.Add(time.Hour)
			if claims.ExpiresAt != nil {
				exp = claims.ExpiresAt.Time
			}
			familyID = claims.TokenID
			return tx.Create(&domain.RefreshSession{
				ID: claims.TokenID, UserID: claims.UserID, FamilyID: familyID,
				ExpiresAt: exp, RotatedAt: &now,
			}).Error
		}
		if e != nil {
			return e
		}
		// Un TokenID apuntado a otra persona no es suyo: la firma es buena,
		// así que no debería pasar nunca, y si pasa no se le da nada.
		if s.UserID != claims.UserID || s.RevokedAt != nil {
			return ErrRefreshRevoked
		}
		familyID = s.FamilyID
		switch {
		case s.RotatedAt == nil:
			return tx.Model(&s).Update("rotated_at", now).Error
		case now.Sub(*s.RotatedAt) <= domain.RefreshReuseGrace:
			return nil
		default:
			if err := tx.Model(&domain.RefreshSession{}).
				Where("family_id = ? AND revoked_at IS NULL", s.FamilyID).
				Update("revoked_at", now).Error; err != nil {
				return err
			}
			stolen = true
			return nil
		}
	})
	if err != nil {
		return "", err
	}
	if stolen {
		return "", ErrRefreshRevoked
	}
	return familyID, nil
}

// RevokeRefreshFamily cierra la sesión a la que pertenece un refresh: todos
// los de su familia, hacia atrás y hacia delante. Es el logout.
func (r *AuthRepository) RevokeRefreshFamily(tokenID string, now time.Time) error {
	var s domain.RefreshSession
	if err := r.db.First(&s, "id = ?", tokenID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	return r.db.Model(&domain.RefreshSession{}).
		Where("family_id = ? AND revoked_at IS NULL", s.FamilyID).
		Update("revoked_at", now).Error
}

// PruneRefresh borra los que ya caducaron hace un día. Una fila caducada no
// vale para nada —el JWT tampoco— y sin esto la tabla sólo crece.
func (r *AuthRepository) PruneRefresh(now time.Time) error {
	return r.db.Where("expires_at < ?", now.Add(-24*time.Hour)).Delete(&domain.RefreshSession{}).Error
}
