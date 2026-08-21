package repository

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

/*
El tope de una escritura cada cinco minutos.

Vive en el WHERE de la propia sentencia, y ahora sostiene bastante más peso que
antes: el latido del stream llama a esto cada 25 segundos por cada persona con
la app abierta. Sin el tope, eso son 144 escrituras por hora y usuario para
contestar una pregunta que no necesita precisión de segundos.

Se fija con un test para que nadie lo quite «simplificando» la consulta.
*/
func TestLaPresenciaNoSeEscribeMasDeUnaVezCadaCincoMinutos(t *testing.T) {
	db, cleanup := lastSeenDB(t)
	defer cleanup()
	repo := NewAuthRepository(db)

	repo.TouchLastSeen("u-ana")
	primera := leerVisto(t, db)
	if primera == nil {
		t.Fatal("la primera vez sí escribe")
	}

	repo.TouchLastSeen("u-ana")
	segunda := leerVisto(t, db)
	if !segunda.Equal(*primera) {
		t.Errorf("la segunda llamada seguida no puede mover la marca: %v → %v", primera, segunda)
	}

	// Y con la marca vieja sí vuelve a escribir, que es la otra mitad: un tope
	// que nunca deja pasar nada sería lo mismo que no registrar presencia.
	if err := db.Exec(`UPDATE users SET last_seen_at = NOW() - INTERVAL '10 minutes' WHERE id = 'u-ana'`).Error; err != nil {
		t.Fatal(err)
	}
	vieja := leerVisto(t, db)
	repo.TouchLastSeen("u-ana")
	if tercera := leerVisto(t, db); !tercera.After(*vieja) {
		t.Error("pasados los cinco minutos tiene que volver a escribir")
	}
}

func leerVisto(t *testing.T, db *gorm.DB) *time.Time {
	t.Helper()
	var u domain.User
	if err := db.First(&u, "id = ?", "u-ana").Error; err != nil {
		t.Fatal(err)
	}
	return u.LastSeenAt
}

func lastSeenDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_last_seen"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	if err := db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at)
		VALUES ('u-ana','ana','a@x.io','x',?,?)`, ahora, ahora).Error; err != nil {
		t.Fatal(err)
	}

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
