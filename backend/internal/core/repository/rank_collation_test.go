package repository

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// El orden de un tablero es una propiedad del **tipo** de la columna, y esta
// prueba está aquí para que siga siéndolo.
//
// Hasta el 10-sep-2026 `rank` era texto en base 62 y lo ordenaba Postgres con
// `ORDER BY rank`, así que el orden dependía de la colación de la base: con una
// de locale, mayúsculas y minúsculas se entremezclan y **el segundo elemento de
// un contenedor se pinta antes que el primero** —los primeros rangos eran «U» y
// «k»—. Producción estaba en `C` y acertaba, pero por suerte: nada en el
// esquema lo pedía.
//
// Ahora es `NUMERIC`, y a un número no hay colación que aplicarle. Devolver
// cualquiera de estas columnas a `varchar` reintroduciría el fallo entero sin
// romper ninguna otra prueba —el orden seguiría saliendo bien en una base `C`—
// así que lo que se vigila es el tipo, no el resultado.
func TestEveryRankColumnIsNumeric(t *testing.T) {
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
	const name = "cac_test_rank_types"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	defer func() {
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if adminSQL != nil {
			adminSQL.Close()
		}
	}()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if sqlDB, e := db.DB(); e == nil {
		defer sqlDB.Close()
	}
	// El esquema tal como lo declara el dominio, que es lo que se comprueba.
	if err := db.AutoMigrate(
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{},
		&domain.TaskStatus{}, &domain.Item{},
	); err != nil {
		t.Fatal(err)
	}

	// La lista sale de la propia migración, no de una copia a mano: una tabla
	// nueva con rango entra aquí sola.
	for _, table := range rankTables {
		var kind string
		db.Raw(`SELECT data_type FROM information_schema.columns
		        WHERE table_name = ? AND column_name = 'rank'`, table.name).Scan(&kind)
		// `tasks` es la tabla vieja de `unify-items-v1`: existe en una base con
		// historia y no en una recién creada, que es lo que este `AutoMigrate`
		// levanta. Que su rango también sea numérico lo comprueba la propia
		// migración, no esto.
		if kind == "" && table.name == "tasks" {
			continue
		}
		if kind != "numeric" {
			t.Errorf("%s.rank es %q, no numeric: el orden vuelve a depender de la colación",
				table.name, kind)
		}
	}
}
