package repository

import (
	"fmt"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Las prioridades que editar dejó como `normal` pasan a `medium` al arrancar
// (#83), y sólo ésas.
//
// Los mutantes que mata: no migrar nada, y tocar además filas que ya estaban
// bien. Y corre dos veces a propósito: arranca en cada despliegue.
func TestNormalPrioritiesBecomeMediumAndNothingElseMoves(t *testing.T) {
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
	const name = "cac_test_priority"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}()
	if err := db.AutoMigrate(&domain.Item{}); err != nil {
		t.Fatal(err)
	}

	antes := map[string]string{
		"editada": "normal", // lo que dejó la edición
		"creada":  "medium", // lo que deja crear
		"alta":    "high",
		"sin":     "none",
	}
	for id, p := range antes {
		it := &domain.Item{OrgID: "o", ListID: "l", Title: id, Status: domain.ReportPending, Priority: domain.ItemPriority(p)}
		it.ID = id
		if err := db.Create(it).Error; err != nil {
			t.Fatal(err)
		}
	}

	canonicalizeItemPriorities(db)
	canonicalizeItemPriorities(db)

	want := map[string]string{"editada": "medium", "creada": "medium", "alta": "high", "sin": "none"}
	for id, w := range want {
		var got string
		if err := db.Raw(`SELECT priority FROM items WHERE id = ?`, id).Scan(&got).Error; err != nil {
			t.Fatal(err)
		}
		if got != w {
			t.Errorf("%s: quedó %q, y es %q", id, got, w)
		}
	}
}
