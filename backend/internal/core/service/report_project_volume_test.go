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

// Cuánto recibió cada integración este mes.
//
// Es lo único que distingue un canal vivo de uno que se configuró y nadie usó
// nunca; sin el número, los dos se ven igual. Cuenta lo que **llegó**: una
// tarea escrita a mano dentro de una lista de cliente lleva el mismo
// project_id, y contarla haría pasar nuestro propio trabajo por actividad del
// cliente.

func TestElVolumenCuentaSoloLoRecibidoEsteMes(t *testing.T) {
	db, cleanup := volumenDB(t)
	defer cleanup()
	repo := repository.NewReportProjectRepository(db)

	ahora := time.Now()
	inicio := time.Date(ahora.Year(), ahora.Month(), 1, 0, 0, 0, 0, ahora.Location())
	n, err := repo.CountSinceByProject(inicio)
	if err != nil {
		t.Fatal(err)
	}
	if n["proy-a"] != 2 {
		t.Errorf("proy-a recibió dos reportes este mes, salieron %d", n["proy-a"])
	}
	// El que no recibió nada no aparece, y la pantalla lo lee como cero.
	if n["proy-b"] != 0 {
		t.Errorf("proy-b no recibió nada este mes, salieron %d", n["proy-b"])
	}
}

func volumenDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_volumen"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Item{}); err != nil {
		t.Fatal(err)
	}

	ahora := time.Now()
	inicioDeMes := time.Date(ahora.Year(), ahora.Month(), 1, 0, 0, 0, 0, ahora.Location())
	esteMes := inicioDeMes.Add(2 * time.Hour)
	mesPasado := inicioDeMes.Add(-48 * time.Hour)

	ins := func(id, proy, origen string, cuando time.Time) {
		db.Exec(`INSERT INTO items (id, project_id, org_id, title, status, origin, created_at, updated_at)
			VALUES (?, ?, 'org-1', 'x', 'pending', ?, ?, ?)`, id, proy, origen, cuando, cuando)
	}
	ins("r-1", "proy-a", "user", esteMes)   // llegó
	ins("r-2", "proy-a", "system", esteMes) // llegó, de una máquina
	ins("r-3", "proy-a", "user", mesPasado) // llegó, pero no este mes
	// Escrita a mano por nosotros en una lista atada al cliente: hereda el
	// project_id pero no es un reporte recibido.
	ins("t-1", "proy-a", "internal", esteMes)
	ins("t-2", "proy-b", "internal", esteMes)
	// Y una tarea nuestra sin canal ninguno.
	ins("t-3", "", "internal", esteMes)

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
