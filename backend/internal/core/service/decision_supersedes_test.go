package service

import (
	"errors"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una decisión que cambia no se edita: se apunta la nueva diciendo a cuál
// sustituye, y la vieja queda marcada (22-oct-2026). Como el registro no se
// borra, el «sustituye a» sólo puede apuntar a una decisión **vigente de la
// misma org**: una de otra org, una ya sustituida o una que no existe se
// quedarían mintiendo para siempre. Desde el 29-oct-2026 puede ser de otro
// documento: así se lleva una decisión al nodo donde se busca
// (command-and-control-250).
//
// Roturas que detecta: no comprobar la org (se sustituye una de otro
// cliente), exigir otra vez el mismo documento, no comprobar que siga vigente
// (dos «la que la sustituyó»), no guardar el enlace, o no resolverlo al leer
// —también cuando la nueva vive en otro documento—.
func TestADecisionSupersedesOnlyALiveOneOfItsOrg(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))

	apuntaEn := func(org, list, title, supersedes string) (*domain.Decision, error) {
		return svc.AddDecision(org, domain.DocOwnerList, list, "u-1", "", "",
			domain.DecisionRequest{Title: title, Origin: "doc", Supersedes: supersedes})
	}
	apunta := func(list, title, supersedes string) (*domain.Decision, error) {
		return apuntaEn("org-1", list, title, supersedes)
	}
	vieja, err := apunta("list-1", "Una release por arreglo", "")
	if err != nil {
		t.Fatal(err)
	}
	deOtraOrg, err := apuntaEn("org-2", "list-9", "De otro cliente", "")
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct{ supersedes, porque string }{
		{deOtraOrg.ID, "es de otra org"},
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

	// Llevarla a otro nodo: la nueva vive en el espacio y sustituye a una de
	// la lista. La vieja, leída suelta y en su registro, sabe quién la
	// sustituyó aunque esté en otro documento.
	enLista, err := apunta("list-3", "El 404 de verdad", "")
	if err != nil {
		t.Fatal(err)
	}
	enEspacio, err := svc.AddDecision("org-1", domain.DocOwnerSpace, "space-1", "u-1", "", "",
		domain.DecisionRequest{Title: "El 404 de verdad", Origin: "doc", Supersedes: enLista.ID})
	if err != nil {
		t.Fatalf("sustituir una de otro documento de la org tiene que valer: %v", err)
	}
	if leida, _ := svc.Decision(enLista.ID); leida == nil || leida.SupersededByID != enEspacio.ID {
		t.Fatalf("la vieja no sabe que la sustituyó una de otro documento: %+v", leida)
	}
	registro, _ := svc.Decisions(enLista.DocID)
	if len(registro) != 1 || registro[0].SupersededByID != enEspacio.ID {
		t.Fatalf("en el registro de la lista no sale marcada: %+v", registro)
	}
}
