package service

import (
	"errors"
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una decisión que dice venir de una tarea apunta a una tarea de verdad (#91).
//
// El registro de decisiones no se puede editar ni borrar, así que un enlace de
// vuelta a algo que no existe —o a la tarea de otro cliente— se queda ahí para
// siempre. Hasta el 28-sep-2026 el backend sólo comprobaba que el id no viniera
// vacío, y por eso el MCP no dejaba nombrar la tarea de origen.

func decisionDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_decision_origin"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Doc{}, &domain.DocTab{}, &domain.Decision{}, &domain.Item{}); err != nil {
		t.Fatal(err)
	}
	for _, x := range []struct{ id, org string }{
		{"task-aqui", "org-1"},
		{"task-ajena", "org-2"},
		{"task-borrada", "org-1"},
	} {
		it := &domain.Item{OrgID: x.org, ListID: "list-1", Title: x.id, Status: domain.ReportPending}
		it.ID = x.id
		if err := db.Create(it).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Delete(&domain.Item{}, "id = ?", "task-borrada").Error; err != nil {
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

// El mutante que mata: quitar la comprobación del servicio. Con ella fuera,
// los tres casos de «no» entran en el registro para siempre.
func TestADecisionPointsBackOnlyToARealTaskOfItsOwn(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))

	desde := func(task string) error {
		_, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u-1", "", "",
			domain.DecisionRequest{Title: "Apagar Koa", Origin: "task", OriginTaskID: task})
		return err
	}

	if err := desde("task-aqui"); err != nil {
		t.Errorf("una tarea de la misma organización tiene que valer: %v", err)
	}
	for _, c := range []struct{ task, porque string }{
		{"task-ajena", "es de otra organización: el enlace llevaría al trabajo de otro cliente"},
		{"no-existe", "no existe"},
		{"task-borrada", "está borrada"},
	} {
		if err := desde(c.task); !errors.Is(err, ErrDecisionOriginNotHere) {
			t.Errorf("%s %s, y se aceptó (err=%v)", c.task, c.porque, err)
		}
	}

	// Lo de siempre sigue igual: una decisión del documento no nombra tarea.
	if _, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u-1", "", "",
		domain.DecisionRequest{Title: "Por correo", Origin: "doc"}); err != nil {
		t.Errorf("una decisión del documento no tiene por qué nombrar tarea: %v", err)
	}
}
