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

// El nombre que sale por el chat y por los directos.
//
// La expresión es SQL, así que el compilador no dice nada de ella: sólo una base
// de datos puede contestar si devuelve «Romanshk Volkov» o «rvolkov». Y el caso
// que importa es el segundo — la fila **con el nombre vacío**, que es por lo que
// se usa `NULLIF` y no un `COALESCE` a secas.
func TestElNombreQueSeEnsena(t *testing.T) {
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
	const name = "cac_test_nombres"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	defer func() {
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
	}()
	if err := db.AutoMigrate(&domain.User{}, &domain.TaskSpace{}); err != nil {
		t.Fatal(err)
	}

	ahora := time.Now()
	insertar := func(id, usuario, nombre string) {
		if err := db.Exec(`INSERT INTO users (id, username, name, email, password, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'x', ?, ?)`, id, usuario, nombre, id+"@x.io", ahora, ahora).Error; err != nil {
			t.Fatal(err)
		}
	}
	insertar("u-con", "rvolkov", "Romanshk Volkov")
	// La razón del `NULLIF`: la columna existe desde antes que el hábito de
	// rellenarla, y `COALESCE` sobre `''` devuelve la cadena vacía en vez de
	// caer al usuario — o sea, un byline en blanco.
	insertar("u-sin", "jguzman", "")

	sp := &domain.TaskSpace{OrgID: "o1", Name: "Portento"}
	if err := db.Create(sp).Error; err != nil {
		t.Fatal(err)
	}

	t.Run("un mensaje de canal lo firma con su nombre", func(t *testing.T) {
		_, autor := NewChatRepository(db).Rotulos(sp.ID, "u-con")
		if autor != "Romanshk Volkov" {
			t.Fatalf("la campana diría %q", autor)
		}
	})

	t.Run("y un directo también", func(t *testing.T) {
		if got := NewDMRepository(db).NombreDe("u-con"); got != "Romanshk Volkov" {
			t.Fatalf("%q", got)
		}
	})

	t.Run("sin nombre puesto, cae al usuario en vez de quedarse en blanco", func(t *testing.T) {
		if got := NewDMRepository(db).NombreDe("u-sin"); got != "jguzman" {
			t.Fatalf("un byline vacío no dice quién escribió: %q", got)
		}
	})

	// Las tres superficies dicen lo mismo de la misma persona, que es el punto
	// entero de tener la expresión en un solo sitio.
	t.Run("la documentación dice lo mismo", func(t *testing.T) {
		if got := NewDocRepository(db).AuthorName("u-con"); got != "Romanshk Volkov" {
			t.Fatalf("%q", got)
		}
	})
}
