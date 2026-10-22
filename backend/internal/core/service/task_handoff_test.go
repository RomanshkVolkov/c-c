package service

import (
	"context"
	"database/sql"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// El «dónde quedó» de una tarea se reemplaza entero, con fecha y autor; vacío
// lo quita, fecha y autor incluidos; y editar otra cosa no lo toca
// (22-oct-2026).
//
// Roturas que detecta: no guardar el texto; guardarlo sin fecha o sin autor
// (uno de hace un mes se leería como de hoy); dejar fecha o autor al vaciarlo;
// o que cualquier otro cambio lo borre.
func TestAHandoffIsReplacedWithItsDateAndAuthorAndEmptyClearsIt(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)
	ctx := context.Background()

	leer := func() (string, bool, string) {
		t.Helper()
		var text, by string
		var at sql.NullTime
		if err := db.Raw(`SELECT handoff, handoff_at, handoff_by_id FROM items WHERE id = ?`, "it-creada").
			Row().Scan(&text, &at, &by); err != nil {
			t.Fatal(err)
		}
		return text, at.Valid, by
	}

	if err := svc.UpdateTask(ctx, "it-creada", "u-ana", domain.UpdateTaskRequest{Handoff: ptr("  Falta la release. Siguiente: probarlo en una llamada.  ")}); err != nil {
		t.Fatal(err)
	}
	if text, con, by := leer(); text != "Falta la release. Siguiente: probarlo en una llamada." || !con || by != "u-ana" {
		t.Fatalf("tenía que quedar el texto limpio, con fecha y autor: %q %v %q", text, con, by)
	}

	if err := svc.UpdateTask(ctx, "it-creada", "u-bea", domain.UpdateTaskRequest{Title: ptr("Otro título")}); err != nil {
		t.Fatal(err)
	}
	if text, _, by := leer(); text == "" || by != "u-ana" {
		t.Fatalf("editar otra cosa no puede tocar el «dónde quedó»: %q %q", text, by)
	}

	if err := svc.UpdateTask(ctx, "it-creada", "u-bea", domain.UpdateTaskRequest{Handoff: ptr("")}); err != nil {
		t.Fatal(err)
	}
	if text, con, by := leer(); text != "" || con || by != "" {
		t.Fatalf("vacío tenía que quitarlo entero: %q %v %q", text, con, by)
	}
}
