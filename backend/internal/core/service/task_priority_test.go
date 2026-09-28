package service

import (
	"context"
	"testing"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// La prioridad media tiene un solo nombre en la base (#83).
//
// Se guarda `medium`; `normal` es sólo como se pide y como se contesta. Crear
// ya lo cumplía y editar no: guardaba la entrada cruda. Y el orden de «mi
// trabajo» preguntaba por `normal`, así que las creadas —casi todas— caían al
// fondo, por debajo de las de prioridad baja.

func storedPriority(t *testing.T, db *gorm.DB, id string) string {
	t.Helper()
	var p string
	if err := db.Raw(`SELECT priority FROM items WHERE id = ?`, id).Scan(&p).Error; err != nil {
		t.Fatal(err)
	}
	return p
}

// Se mira la columna, no la respuesta: la respuesta pasa por TaskWire y dice
// `normal` en los dos casos, que es justo por lo que esto pasó sin que se viera.
//
// El mutante que mata: volver a guardar la entrada cruda al editar.
func TestEditingAPriorityStoresWhatCreatingStores(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)
	ctx := context.Background()

	var li domain.TaskList
	if err := db.First(&li, "id = ?", "list-1").Error; err != nil {
		t.Fatal(err)
	}
	creada, err := svc.CreateTask(ctx, &li, "org-1", "u-ana",
		domain.CreateTaskRequest{Title: "Nueva", Priority: "normal"})
	if err != nil {
		t.Fatal(err)
	}

	normal := domain.PriorityNormal
	if err := svc.UpdateTask(ctx, "it-creada", "u-ana", domain.UpdateTaskRequest{Priority: &normal}); err != nil {
		t.Fatal(err)
	}

	if got := storedPriority(t, db, creada.ID); got != "medium" {
		t.Errorf("crear guardó %q", got)
	}
	if got := storedPriority(t, db, "it-creada"); got != "medium" {
		t.Errorf("editar guardó %q, y crear guarda \"medium\": dos nombres para lo mismo", got)
	}
}

// El fallo que se veía: en «mi trabajo», media tiene que ir entre alta y baja.
//
// El mutante que mata: devolver `'normal'` al CASE del orden. Con él, `medium`
// cae en el ELSE junto a las que no tienen prioridad, por debajo de las bajas.
func TestMyWorkPutsMediumBetweenHighAndLow(t *testing.T) {
	db, cleanup := myWorkDB(t)
	defer cleanup()
	svc := myWorkSvc(db)

	// Metidas desordenadas a propósito: si salen en orden es por la prioridad.
	for _, p := range []domain.ItemPriority{"low", "none", "medium", "urgent", "high"} {
		it := &domain.Item{
			OrgID: "org-1", ListID: "list-1", Title: string(p),
			CreatedByID: "u-ana", Status: domain.ReportPending, Priority: p,
		}
		it.ID = "prio-" + string(p)
		if err := db.Create(it).Error; err != nil {
			t.Fatal(err)
		}
	}

	got, err := svc.ListOpen([]string{"org-1"}, false, "org-1", 0, domain.OpenTaskFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var orden []string
	for _, x := range got {
		if len(x.ID) > 5 && x.ID[:5] == "prio-" {
			orden = append(orden, x.ID[5:])
		}
	}
	want := []string{"urgent", "high", "medium", "low", "none"}
	if len(orden) != len(want) {
		t.Fatalf("salieron %v", orden)
	}
	for i := range want {
		if orden[i] != want[i] {
			t.Fatalf("el orden es %v, y tiene que ser %v", orden, want)
		}
	}
}
