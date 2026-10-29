package service

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// En el mapa, cada título lleva el id de su sección y sus decisiones; y si la
// sección guardada está atrasada (otro título en ese puesto), sale sin id antes
// que con el de otra (command-and-control-91).
func TestContextHeadingsCarryTheirSectionOnlyWhenItMatches(t *testing.T) {
	body := "# Runbook\n\n## Desplegar\n\nx\n\n#### Muy hondo\n\n## Volver\n\ny\n"
	secs := map[int]repository.ContextSection{
		0: {ID: "s0", Heading: "Runbook"},
		1: {ID: "s1", Heading: "Desplegar", Decisions: []string{"d1"}},
		2: {ID: "s2", Heading: "Muy hondo"},
		3: {ID: "s3", Heading: "Otro título"},
	}
	got := contextHeadings(body, secs)
	if len(got) != 3 {
		t.Fatalf("el nivel 4 no se queda fuera: %+v", got)
	}
	if got[0].ID != "s0" || got[1].ID != "s1" || len(got[1].Decisions) != 1 || got[1].Decisions[0] != "d1" {
		t.Fatalf("%+v", got)
	}
	if got[2].Text != "Volver" || got[2].ID != "" {
		t.Fatalf("un título que no casa se lleva el id de otra sección: %+v", got[2])
	}
}
