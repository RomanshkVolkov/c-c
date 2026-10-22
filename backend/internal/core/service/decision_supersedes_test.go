package service

import (
	"errors"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una decisión que cambia no se edita: se apunta la nueva diciendo a cuál
// sustituye, y la vieja queda marcada (22-oct-2026). Como el registro no se
// borra, el «sustituye a» sólo puede apuntar a una decisión **vigente del mismo
// documento**: una de otro documento, una ya sustituida o una que no existe se
// quedarían mintiendo para siempre.
//
// Roturas que detecta: no comprobar el documento (se sustituye una de otra
// lista), no comprobar que siga vigente (dos «la que la sustituyó»), no
// guardar el enlace, o no resolverlo al leer (la vieja no sabría que ya no
// vale).
func TestADecisionSupersedesOnlyALiveOneOfItsOwnDocument(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))

	apunta := func(list, title, supersedes string) (*domain.Decision, error) {
		return svc.AddDecision("org-1", domain.DocOwnerList, list, "u-1", "", "",
			domain.DecisionRequest{Title: title, Origin: "doc", Supersedes: supersedes})
	}
	vieja, err := apunta("list-1", "Una release por arreglo", "")
	if err != nil {
		t.Fatal(err)
	}
	deOtra, err := apunta("list-2", "De otro documento", "")
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct{ supersedes, porque string }{
		{deOtra.ID, "es de otro documento"},
		{"no-existe", "no existe"},
	} {
		if _, err := apunta("list-1", "Las releases se juntan", c.supersedes); !errors.Is(err, ErrDecisionSupersedesNotHere) {
			t.Errorf("sustituir una que %s se aceptó (err=%v)", c.porque, err)
		}
	}

	nueva, err := apunta("list-1", "Las releases se juntan", vieja.ID)
	if err != nil {
		t.Fatalf("sustituir una vigente del mismo documento tiene que valer: %v", err)
	}
	if nueva.SupersedesID != vieja.ID {
		t.Fatalf("la nueva no dice a cuál sustituye: %+v", nueva)
	}
	// La vieja ya no está vigente: nadie más puede sustituirla; se sustituye a
	// la que la sustituyó.
	if _, err := apunta("list-1", "Otra vez", vieja.ID); !errors.Is(err, ErrDecisionAlreadySuperseded) {
		t.Errorf("sustituir una ya sustituida se aceptó (err=%v)", err)
	}

	// Y al leer, la vieja sabe quién la dejó sin efecto: suelta y en el registro.
	leida, err := svc.Decision(vieja.ID)
	if err != nil {
		t.Fatal(err)
	}
	if leida.SupersededByID != nueva.ID {
		t.Fatalf("la vieja leída suelta no dice quién la sustituyó: %+v", leida)
	}
	todas, err := svc.Decisions(nueva.DocID)
	if err != nil {
		t.Fatal(err)
	}
	var marcada bool
	for _, d := range todas {
		if d.ID == vieja.ID && d.SupersededByID == nueva.ID {
			marcada = true
		}
	}
	if !marcada || len(todas) != 2 {
		t.Fatalf("el registro entero conserva la vieja, marcada: %+v", todas)
	}
}
