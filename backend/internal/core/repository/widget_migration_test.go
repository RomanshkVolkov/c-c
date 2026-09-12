package repository

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// El borrado de las columnas del widget, ensayado contra datos como los de
// producción. Es irreversible, así que lo que no puede pasar es que se lleve
// por delante algo de al lado: la clave de un proyecto vivo, su límite o su
// bandeja.
func widgetMigrationDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_widget_migration"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	// El esquema **viejo**, a mano: con las dos columnas del widget. Pedírselo a
	// `AutoMigrate` lo crearía ya sin ellas y la prueba no ensayaría nada.
	if err := db.Exec(`CREATE TABLE report_projects (
		id varchar(36) PRIMARY KEY,
		slug varchar(120),
		ingest_key_hash bytea,
		rate_limit_per_hour int,
		list_id varchar(36),
		is_active boolean,
		platform varchar(10) DEFAULT 'web',
		allowed_origins jsonb)`).Error; err != nil {
		t.Fatal(err)
	}
	return db, func() {
		if sqlDB, e := db.DB(); e == nil {
			sqlDB.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if adminSQL != nil {
			adminSQL.Close()
		}
	}
}

func columnsOf(t *testing.T, db *gorm.DB) map[string]bool {
	t.Helper()
	var names []string
	if err := db.Raw(`SELECT column_name FROM information_schema.columns
	                  WHERE table_name = 'report_projects'`).Scan(&names).Error; err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, n := range names {
		out[n] = true
	}
	return out
}

func TestTheWidgetColumnsAreGone(t *testing.T) {
	db, cleanup := widgetMigrationDB(t)
	defer cleanup()

	dropWidgetColumns(db)

	cols := columnsOf(t, db)
	if cols["platform"] || cols["allowed_origins"] {
		t.Fatalf("quedaron columnas del widget: %v", cols)
	}
}

// Lo que de verdad puede salir mal en un borrado: llevarse lo de al lado. Un
// proyecto tiene que sobrevivir entero — su clave sobre todo, que no se puede
// volver a leer si se pierde.
func TestAProjectSurvivesIntact(t *testing.T) {
	db, cleanup := widgetMigrationDB(t)
	defer cleanup()
	db.Exec(`INSERT INTO report_projects
		(id, slug, ingest_key_hash, rate_limit_per_hour, list_id, is_active, platform, allowed_origins)
		VALUES ('p-1', 'portento', '\x6869', 500, 'lista-1', true, 'app', '["https://x.test"]')`)

	dropWidgetColumns(db)

	var fila struct {
		Slug             string
		IngestKeyHash    []byte
		RateLimitPerHour int
		ListID           string
		IsActive         bool
	}
	if err := db.Raw(`SELECT slug, ingest_key_hash, rate_limit_per_hour, list_id, is_active
	                  FROM report_projects WHERE id = 'p-1'`).Scan(&fila).Error; err != nil {
		t.Fatal(err)
	}
	if fila.Slug != "portento" || string(fila.IngestKeyHash) != "hi" ||
		fila.RateLimitPerHour != 500 || fila.ListID != "lista-1" || !fila.IsActive {
		t.Fatalf("el proyecto no sobrevivió entero: %+v", fila)
	}
}

// Arranca en cada despliegue, así que la segunda vez no tiene nada que hacer.
func TestRunningItTwiceIsFine(t *testing.T) {
	db, cleanup := widgetMigrationDB(t)
	defer cleanup()

	dropWidgetColumns(db)
	dropWidgetColumns(db) // sin pánico
	if cols := columnsOf(t, db); cols["platform"] {
		t.Fatal("la segunda pasada resucitó algo")
	}
}

// Una base recién creada no tiene todavía la tabla: esto corre antes de
// `AutoMigrate`. Tiene que no hacer nada, no reventar el arranque.
func TestAFreshDatabaseHasNothingToDrop(t *testing.T) {
	db, cleanup := widgetMigrationDB(t)
	defer cleanup()
	db.Exec(`DROP TABLE report_projects`)

	dropWidgetColumns(db) // sin tabla, y sin pánico
}
