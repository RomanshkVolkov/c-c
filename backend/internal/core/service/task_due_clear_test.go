package service

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Quitar el vencimiento de una tarea lo quita (#95).
//
// `DueAt` es un puntero, y `"dueAt": null` llega como `nil`, que significa «no
// tocar». La app mandaba justo eso al vaciar la fecha, así que el vencimiento se
// quedaba y volvía a salir al recargar, sin ningún error.
//
// Los mutantes que mata: ignorar `ClearDueAt`, y que quitarlo gane aunque se
// esté poniendo una fecha nueva en otra petición —la de sólo poner no puede
// borrar—.
func TestClearingADueDateClearsIt(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)
	ctx := context.Background()

	due := func() *time.Time {
		t.Helper()
		var d sql.NullTime
		if err := db.Raw(`SELECT due_at FROM items WHERE id = ?`, "it-creada").Row().Scan(&d); err != nil {
			t.Fatal(err)
		}
		if !d.Valid {
			return nil
		}
		return &d.Time
	}

	el30 := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	if err := svc.UpdateTask(ctx, "it-creada", "u-ana", domain.UpdateTaskRequest{DueAt: &el30}); err != nil {
		t.Fatal(err)
	}
	if d := due(); d == nil || !d.Equal(el30) {
		t.Fatalf("poner la fecha tenía que guardarla, y hay %v", d)
	}

	// Lo que mandaba la app: nada de fecha. No tiene que tocarla.
	if err := svc.UpdateTask(ctx, "it-creada", "u-ana", domain.UpdateTaskRequest{Title: ptr("Otro título")}); err != nil {
		t.Fatal(err)
	}
	if due() == nil {
		t.Fatal("editar otra cosa no puede quitar el vencimiento")
	}

	if err := svc.UpdateTask(ctx, "it-creada", "u-ana", domain.UpdateTaskRequest{ClearDueAt: true}); err != nil {
		t.Fatal(err)
	}
	if d := due(); d != nil {
		t.Errorf("quitar el vencimiento tenía que dejarlo vacío, y sigue %v", d)
	}
}

