package service

import (
	"context"
	"errors"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Reclamar una tarea y depender de otra, para que dos agentes a la vez no se
// pisen sin enterarse (22-oct-2026).
//
// Roturas que detecta: reclamar sin pasar a en curso o sin ponerse de
// responsable; quitar al dueño al reclamar; dejar que un segundo reclame lo
// que ya está en curso con otro; ignorar `ifStatus`; aceptar como dependencia
// una tarea que no existe o la propia; no resolver una dependencia por su
// referencia; o no decir en el detalle si la dependencia sigue abierta.
func TestClaimingAndBlockingKeepTwoAgentsFromSteppingOnEachOther(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)
	ctx := context.Background()
	// La fixture usa los ids de Ana y Bea pero no crea sus filas, y el detalle
	// resuelve los responsables por `users`.
	for _, u := range []struct{ id, name string }{{"u-ana", "ana"}, {"u-bea", "bea"}} {
		user := &domain.User{Username: u.name}
		user.ID = u.id
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Ana reclama: en curso y responsable. Bea no puede reclamarla; Ana sí
	// otra vez (es suya).
	if err := svc.ClaimTask(ctx, "it-creada", "u-ana", "pending"); err != nil {
		t.Fatal(err)
	}
	d, err := svc.Detail("it-creada")
	if err != nil {
		t.Fatal(err)
	}
	if d.Task.Status != domain.ReportInProgress || len(d.Assignees) != 1 || d.Assignees[0].ID != "u-ana" {
		t.Fatalf("reclamar es en curso + responsable: %s %+v", d.Task.Status, d.Assignees)
	}
	if err := svc.ClaimTask(ctx, "it-creada", "u-bea", ""); !errors.Is(err, ErrTaskClaimedByOther) {
		t.Fatalf("Bea reclamó lo que Ana lleva: %v", err)
	}
	if err := svc.ClaimTask(ctx, "it-creada", "u-ana", ""); err != nil {
		t.Fatalf("Ana puede volver a reclamar la suya: %v", err)
	}
	// `ifStatus` de un estado que ya no es: no se toca.
	if err := svc.ClaimTask(ctx, "it-creada", "u-ana", "pending"); !errors.Is(err, ErrTaskStatusChanged) {
		t.Fatalf("ifStatus=pending con la tarea en curso tenía que fallar: %v", err)
	}
	if err := svc.UpdateTask(ctx, "it-creada", "u-ana", domain.UpdateTaskRequest{IfStatus: ptr("pending"), Title: ptr("x")}); !errors.Is(err, ErrTaskStatusChanged) {
		t.Fatalf("UpdateTask con ifStatus viejo tenía que fallar: %v", err)
	}
	if err := svc.MoveTask(ctx, "it-creada", "u-ana", domain.MoveTaskRequest{StatusID: "list-1/pending", IfStatus: "resolved"}); !errors.Is(err, ErrTaskStatusChanged) {
		t.Fatalf("MoveTask con ifStatus viejo tenía que fallar: %v", err)
	}
	// Reclamar una tarea que ya tiene dueño pero está pendiente: se suma, no
	// sustituye.
	if err := svc.ClaimTask(ctx, "it-tabla", "u-bea", ""); err != nil {
		t.Fatal(err)
	}
	d, _ = svc.Detail("it-tabla")
	if len(d.Assignees) != 2 {
		t.Fatalf("reclamar no quita al dueño: %+v", d.Assignees)
	}

	// Dependencias: por id y por referencia; ni inexistentes ni ella misma.
	if err := db.Model(&domain.TaskSpace{}).Where("id = ?", "space-1").Update("key", "esp").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&domain.Item{}).Where("id = ?", "it-tabla").Updates(map[string]any{"seq": 5, "space_id": "space-1"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.UpdateTask(ctx, "it-cerrada", "u-ana", domain.UpdateTaskRequest{BlockedBy: &[]string{"it-creada", "esp-5"}}); err != nil {
		t.Fatalf("depender por id y por referencia: %v", err)
	}
	d, _ = svc.Detail("it-cerrada")
	if len(d.BlockedBy) != 2 || d.BlockedBy[1].Ref != "esp-5" || !d.BlockedBy[0].Open || !d.BlockedBy[1].Open {
		t.Fatalf("el detalle dice de qué depende, con referencia y si sigue abierta: %+v", d.BlockedBy)
	}
	for _, bad := range []string{"no-existe", "esp-99"} {
		if err := svc.UpdateTask(ctx, "it-cerrada", "u-ana", domain.UpdateTaskRequest{BlockedBy: &[]string{bad}}); !errors.Is(err, ErrBlockerNotFound) {
			t.Errorf("depender de %q se aceptó: %v", bad, err)
		}
	}
	if err := svc.UpdateTask(ctx, "it-cerrada", "u-ana", domain.UpdateTaskRequest{BlockedBy: &[]string{"it-cerrada"}}); !errors.Is(err, ErrBlockerIsSelf) {
		t.Errorf("depender de sí misma se aceptó: %v", err)
	}
	if err := svc.UpdateTask(ctx, "it-cerrada", "u-ana", domain.UpdateTaskRequest{BlockedBy: &[]string{}}); err != nil {
		t.Fatal(err)
	}
	if d, _ := svc.Detail("it-cerrada"); len(d.BlockedBy) != 0 {
		t.Fatalf("la lista vacía quita las dependencias: %+v", d.BlockedBy)
	}
}
