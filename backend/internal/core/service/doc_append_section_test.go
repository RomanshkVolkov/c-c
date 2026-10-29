package service

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Un agente deja una trampa en «Trampas que ya han mordido» con el permiso de
// añadir (docs:write), aunque el nodo no tenga overview todavía, y aunque la
// sección no sea la última (command-and-control-252). Roturas que detecta:
// ignorar `section` (va al final de la pestaña, bajo la sección que toque),
// no crear la pestaña si falta, o no recalcular el hash (el siguiente
// guardado con baseHash se rechazaría o se aceptaría por razones falsas).
func TestATrapLandsInItsSectionOfTheOverview(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	repo := repository.NewDocRepository(db)
	svc := NewDocService(repo)
	const trampas = "Trampas que ya han mordido"
	overview := func() domain.DocTab {
		doc, err := repo.Find(domain.DocOwnerSpace, "space-1")
		if err != nil {
			t.Fatal(err)
		}
		tabs, _ := repo.Tabs(doc.ID)
		for _, tb := range tabs {
			if tb.Key == domain.DocOverview {
				return tb
			}
		}
		t.Fatal("no hay overview")
		return domain.DocTab{}
	}

	if _, err := svc.AppendTab("org-1", domain.DocOwnerSpace, "space-1", domain.DocOverview, trampas, "- La primera.", "u-1"); err != nil {
		t.Fatal(err)
	}
	if got := overview().Body; got != "## "+trampas+"\n\n- La primera.\n" {
		t.Fatalf("sin overview: %q", got)
	}
	// Alguien escribe otra sección detrás; la siguiente trampa no va al final.
	if _, err := svc.AppendTab("org-1", domain.DocOwnerSpace, "space-1", domain.DocOverview, "", "## Enlaces\n\n- x", "u-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AppendTab("org-1", domain.DocOwnerSpace, "space-1", domain.DocOverview, trampas, "- La segunda.", "u-1"); err != nil {
		t.Fatal(err)
	}
	tab := overview()
	want := "## " + trampas + "\n\n- La primera.\n\n- La segunda.\n\n## Enlaces\n\n- x"
	if tab.Body != want {
		t.Fatalf("en medio:\n%q\nquería\n%q", tab.Body, want)
	}
	if tab.BodyHash != repository.HashBody(want) {
		t.Errorf("el hash no es el del cuerpo que quedó")
	}
}
