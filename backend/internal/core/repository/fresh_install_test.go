package repository

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// A first deploy, and a restore into an empty database, both look like this.
//
// The migration used to panic here — it went looking for the tables it was
// written to copy out of, and on a database that never had them the collision
// check failed and took the boot with it. A crash loop is the right answer when
// data is at risk and the wrong one when there is simply no data yet.
func TestAFreshDatabaseIsNotAFailedMigration(t *testing.T) {
	db, cleanup := freshDB(t)
	defer cleanup()

	if hasLegacyItemTables(db) {
		t.Fatal("a database with no reports/tasks tables must not read as a migratable one")
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("booting against an empty database panicked: %v", r)
		}
	}()
	migrateItems(db)

	// And it says so, rather than leaving the next boot to rediscover it.
	var detail string
	db.Raw(`SELECT detail FROM schema_backfills WHERE name = ?`, itemBackfillName).Scan(&detail)
	if detail == "" {
		t.Error("nothing was recorded, so there is no trace this ran at all")
	}
}

// One table without the other is not a shape this migration understands, and
// guessing is how half a copy gets made.
func TestAHalfMigratedSchemaIsNotTreatedAsFresh(t *testing.T) {
	db, cleanup := freshDB(t)
	defer cleanup()

	if err := db.Exec(`CREATE TABLE reports (id varchar(36) PRIMARY KEY)`).Error; err != nil {
		t.Fatal(err)
	}
	if hasLegacyItemTables(db) {
		t.Error("reports alone must not count as the old schema: tasks is missing and the copy joins them")
	}

	if err := db.Exec(`CREATE TABLE tasks (id varchar(36) PRIMARY KEY)`).Error; err != nil {
		t.Fatal(err)
	}
	if !hasLegacyItemTables(db) {
		t.Error("with both present this is the old schema and the copy must run")
	}
}

func freshDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_fresh"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	return db, func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
