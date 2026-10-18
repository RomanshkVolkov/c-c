package repository_test

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// El color de un espacio sobrevive a renombrarlo.
//
// La app renombra mandando sólo el nombre, y hasta el 18-oct-2026 el servidor
// guardaba también el color que llegara —ninguno—, así que elegir un color y
// renombrar después lo borraba. Ahora un color ausente no se toca y uno vacío
// sí lo quita.
func TestRenamingASpaceKeepsItsColor(t *testing.T) {
	db, cleanup := openTaskDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)

	space := &domain.TaskSpace{OrgID: "org-1", Name: "Producto", Color: "#60A5FA"}
	space.ID = "sp-color"
	if err := db.Create(space).Error; err != nil {
		t.Fatal(err)
	}
	colorOf := func() string {
		var got domain.TaskSpace
		if err := db.First(&got, "id = ?", space.ID).Error; err != nil {
			t.Fatal(err)
		}
		return got.Color
	}

	if err := repo.UpdateSpace(space.ID, "Producto 2", nil); err != nil {
		t.Fatal(err)
	}
	if got := colorOf(); got != "#60A5FA" {
		t.Fatalf("renombrar sin color lo cambió a %q", got)
	}

	green := "#4ADE80"
	if err := repo.UpdateSpace(space.ID, "Producto 2", &green); err != nil {
		t.Fatal(err)
	}
	if got := colorOf(); got != green {
		t.Fatalf("el color nuevo no se guardó: %q", got)
	}

	none := ""
	if err := repo.UpdateSpace(space.ID, "Producto 2", &none); err != nil {
		t.Fatal(err)
	}
	if got := colorOf(); got != "" {
		t.Fatalf("un color vacío tenía que quitarlo, quedó %q", got)
	}
}

// Una etiqueta cambia sólo lo que se le manda.
func TestUpdatingATagTouchesOnlyWhatIsSent(t *testing.T) {
	db, cleanup := openTaskDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.TaskTag{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewTaskRepository(db)

	tag := &domain.TaskTag{OrgID: "org-1", Name: "bug", Color: "#8B5CF6"}
	tag.ID = "tag-1"
	if err := repo.CreateTag(tag); err != nil {
		t.Fatal(err)
	}

	red := "#F87171"
	got, err := repo.UpdateTag(tag.ID, nil, &red)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "bug" || got.Color != red {
		t.Fatalf("cambiar el color tocó otra cosa: %+v", got)
	}

	name := "error"
	got, err = repo.UpdateTag(tag.ID, &name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "error" || got.Color != red {
		t.Fatalf("cambiar el nombre tocó el color: %+v", got)
	}
}
