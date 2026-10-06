package service

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
Barrido de seguridad (6-oct-2026). Una sesión web vive en un navegador, que es
un sitio más expuesto que el escritorio, y no llega a lo que sólo tiene sentido
en él (servidores, tokens personales). Lo que la marca es un claim firmado, así
que tiene que salir del login y sobrevivir a cada renovación.
*/

func authDB(t *testing.T) *AuthService {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_web_session"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.Organization{}, &domain.OrgMembership{}, &domain.RefreshSession{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})
	hash, _ := repository.HashPassword("vieja-clave")
	ahora := time.Now()
	if err := db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at)
		VALUES ('u-ana', 'ana', 'ana@x.io', ?, ?, ?)`, hash, ahora, ahora).Error; err != nil {
		t.Fatal(err)
	}
	return NewAuthService(repository.NewAuthRepository(db))
}

func webOf(t *testing.T, access, refresh string) (bool, bool) {
	t.Helper()
	a, err := repository.ValidateAccessToken(access)
	if err != nil {
		t.Fatal(err)
	}
	r, err := repository.ValidateRefreshToken(refresh)
	if err != nil {
		t.Fatal(err)
	}
	return a.Web, r.Web
}

// Entrar desde la web marca los dos tokens; desde el escritorio, ninguno; y
// renovar conserva lo que había. Mutantes: ignorar `Client`; renovar como
// escritorio (la sesión web perdería la marca a los 15 minutos).
func TestAWebSessionIsMarkedAndStaysWeb(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "a-test")
	t.Setenv("JWT_SECRET_REFRESH", "r-test")
	svc := authDB(t)

	web, err := svc.Login(domain.LoginRequest{Username: "ana", Password: "vieja-clave", Client: "web"})
	if err != nil {
		t.Fatal(err)
	}
	if a, r := webOf(t, web.AccessToken, web.RefreshToken); !a || !r {
		t.Fatalf("login web sin marca: acceso %v, refresh %v", a, r)
	}
	renovada, err := svc.RefreshToken(web.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if a, r := webOf(t, renovada.AccessToken, renovada.RefreshToken); !a || !r {
		t.Errorf("al renovarse la sesión web dejó de serlo: acceso %v, refresh %v", a, r)
	}

	esc, err := svc.Login(domain.LoginRequest{Username: "ana", Password: "vieja-clave"})
	if err != nil {
		t.Fatal(err)
	}
	if a, r := webOf(t, esc.AccessToken, esc.RefreshToken); a || r {
		t.Errorf("el escritorio salió marcado como web: acceso %v, refresh %v", a, r)
	}
}

// Cambiar la contraseña cierra todas las sesiones —quien la sabía no sigue
// dentro con su refresh— y deja dentro a quien la cambió, con su misma clase
// de sesión. Mutantes: no revocar; emitir la nueva como escritorio.
func TestChangingThePasswordEndsEveryOtherSession(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "a-test")
	t.Setenv("JWT_SECRET_REFRESH", "r-test")
	svc := authDB(t)

	ladron, err := svc.Login(domain.LoginRequest{Username: "ana", Password: "vieja-clave"})
	if err != nil {
		t.Fatal(err)
	}
	nueva, err := svc.ChangePassword("u-ana", "vieja-clave", "nueva-clave-larga", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RefreshToken(ladron.RefreshToken); err == nil {
		t.Error("una sesión de antes del cambio sigue renovándose")
	}
	if a, r := webOf(t, nueva.AccessToken, nueva.RefreshToken); !a || !r {
		t.Errorf("la sesión de quien la cambió en la web dejó de ser web: %v %v", a, r)
	}
	if _, err := svc.RefreshToken(nueva.RefreshToken); err != nil {
		t.Errorf("quien la cambió quedó fuera: %v", err)
	}
}
