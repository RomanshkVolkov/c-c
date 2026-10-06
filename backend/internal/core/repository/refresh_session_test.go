package repository

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

/*
El refresh con estado (W0 de la versión web): cada refresh se canjea una vez,
dos canjes casi juntos no echan a nadie, y uno reutilizado más tarde revoca la
sesión entera. Contra Postgres de verdad, porque lo que se prueba es el bloqueo
de la fila y que la revocación quede escrita.
*/

func refreshDB(t *testing.T) *AuthRepository {
	t.Helper()
	if GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			GetEnv("DB_HOST", "localhost"), GetEnv("DB_PORT", "5432"),
			GetEnv("DB_USER", "postgres"), GetEnv("DB_PASSWORD", ""),
			name, GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_refresh"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.RefreshSession{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})
	return NewAuthRepository(db)
}

var t0 = time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)

func pair(id string) *domain.TokenPair {
	return &domain.TokenPair{RefreshID: id, RefreshExpiresAt: t0.Add(7 * 24 * time.Hour)}
}

func claimsOf(id, user string) *domain.ClaimsRefresh {
	return &domain.ClaimsRefresh{TokenID: id, UserID: user,
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(t0.Add(7 * 24 * time.Hour))}}
}

// Un refresh vale una vez. Dentro del margen de gracia vale otra (dos
// peticiones con el mismo token casi juntas); fuera, alguien tiene una copia y
// cae la familia entera, **también el refresh nuevo** que sacó el dueño
// legítimo. Mutantes: no rotar (el reúso nunca se detecta), margen
// `<` → siempre o nunca, revocar sólo la fila presentada y no la familia, o
// devolver el error desde dentro de la transacción (deshace la revocación).
func TestARefreshIsUsedOnceAndReuseRevokesTheSession(t *testing.T) {
	repo := refreshDB(t)
	if err := repo.SaveRefresh("u-1", "", pair("a")); err != nil {
		t.Fatal(err)
	}
	fam, err := repo.ClaimRefresh(claimsOf("a", "u-1"), t0)
	if err != nil || fam != "a" {
		t.Fatalf("primer canje: %q %v", fam, err)
	}
	// El dueño sigue con el refresh nuevo de la misma familia.
	if err := repo.SaveRefresh("u-1", fam, pair("b")); err != nil {
		t.Fatal(err)
	}
	// La carrera: el mismo refresh otra vez a los 30 s. Vale.
	if fam, err := repo.ClaimRefresh(claimsOf("a", "u-1"), t0.Add(30*time.Second)); err != nil || fam != "a" {
		t.Fatalf("dentro del margen: %q %v", fam, err)
	}
	// A los dos minutos ya no es una carrera.
	if _, err := repo.ClaimRefresh(claimsOf("a", "u-1"), t0.Add(2*time.Minute)); !errors.Is(err, ErrRefreshRevoked) {
		t.Fatalf("reúso fuera del margen → %v, se esperaba revocado", err)
	}
	// Y la sesión entera cayó: el refresh nuevo tampoco vale.
	if _, err := repo.ClaimRefresh(claimsOf("b", "u-1"), t0.Add(3*time.Minute)); !errors.Is(err, ErrRefreshRevoked) {
		t.Errorf("el refresh nuevo de una familia robada → %v, se esperaba revocado", err)
	}
}

// Los refresh de antes de la tabla no están apuntados. Se adoptan una vez, en
// vez de echar a todo el mundo el día del despliegue; y desde ese momento
// siguen las mismas reglas. Mutante: rechazar lo no apuntado (logout masivo), o
// adoptarlo sin marcarlo rotado (valdría para siempre).
func TestAnUnknownRefreshIsAdoptedOnce(t *testing.T) {
	repo := refreshDB(t)
	fam, err := repo.ClaimRefresh(claimsOf("viejo", "u-1"), t0)
	if err != nil || fam != "viejo" {
		t.Fatalf("un refresh de antes de la tabla: %q %v", fam, err)
	}
	if _, err := repo.ClaimRefresh(claimsOf("viejo", "u-1"), t0.Add(2*time.Minute)); !errors.Is(err, ErrRefreshRevoked) {
		t.Errorf("el mismo refresh viejo otra vez, fuera del margen → %v", err)
	}
}

// Salir revoca la familia del refresh presentado, y sólo ésa: la sesión de otro
// dispositivo de la misma persona sigue. Mutante: revocar por usuario.
func TestLogoutRevokesOnlyThatSession(t *testing.T) {
	repo := refreshDB(t)
	repo.SaveRefresh("u-1", "", pair("portatil"))
	repo.SaveRefresh("u-1", "", pair("telefono"))
	if err := repo.RevokeRefreshFamily("portatil", t0); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ClaimRefresh(claimsOf("portatil", "u-1"), t0); !errors.Is(err, ErrRefreshRevoked) {
		t.Errorf("tras salir, el refresh → %v", err)
	}
	if _, err := repo.ClaimRefresh(claimsOf("telefono", "u-1"), t0); err != nil {
		t.Errorf("la sesión del otro dispositivo cayó: %v", err)
	}
	// Salir con uno que no existe no es un error.
	if err := repo.RevokeRefreshFamily("nadie", t0); err != nil {
		t.Errorf("salir con un refresh desconocido → %v", err)
	}
}

// Un TokenID apuntado a otra persona no se canjea, aunque la firma sea buena.
// Mutante: no comparar el usuario.
func TestARefreshOfSomeoneElseIsRefused(t *testing.T) {
	repo := refreshDB(t)
	repo.SaveRefresh("u-1", "", pair("a"))
	if _, err := repo.ClaimRefresh(claimsOf("a", "u-2"), t0); !errors.Is(err, ErrRefreshRevoked) {
		t.Errorf("el refresh de u-1 presentado como u-2 → %v", err)
	}
}

// Lo caducado hace más de un día se borra; lo vigente no. Mutante: borrar por
// `expires_at < now` sin el día de margen, o al revés.
func TestPruneDropsOnlyWhatExpiredADayAgo(t *testing.T) {
	repo := refreshDB(t)
	viejo := &domain.TokenPair{RefreshID: "viejo", RefreshExpiresAt: t0.Add(-48 * time.Hour)}
	reciente := &domain.TokenPair{RefreshID: "reciente", RefreshExpiresAt: t0.Add(-time.Hour)}
	repo.SaveRefresh("u-1", "", viejo)
	repo.SaveRefresh("u-1", "", reciente)
	repo.SaveRefresh("u-1", "", pair("vigente"))
	if err := repo.PruneRefresh(t0); err != nil {
		t.Fatal(err)
	}
	var ids []string
	repo.db.Model(&domain.RefreshSession{}).Order("id").Pluck("id", &ids)
	if fmt.Sprint(ids) != "[reciente vigente]" {
		t.Errorf("quedaron %v", ids)
	}
}
