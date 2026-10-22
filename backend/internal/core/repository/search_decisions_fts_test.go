package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Las decisiones se buscan (22-oct-2026). Hasta entonces el registro no estaba
// en el índice: «releases se juntan», el título de una decisión, devolvía cero,
// y lo que se apuntaba «para leerse dentro de un año» no lo encontraba nadie.
// Una sustituida no sale: lo que se busca es lo que vale hoy.
//
// Roturas que detecta: no indexarlas; devolverlas sin decir de qué nodo son o
// sin enlace a su pestaña; enseñar una sustituida; o mezclar la de otra
// organización.
func TestADecisionIsFoundAndASupersededOneIsNot(t *testing.T) {
	db := searchFTSDB(t)
	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerList, OwnerID: "l"}
	doc.ID = "doc-l"
	if err := db.Create(doc).Error; err != nil {
		t.Fatal(err)
	}
	ajeno := &domain.Doc{OrgID: "org-2", OwnerKind: domain.DocOwnerList, OwnerID: "l-ajena"}
	ajeno.ID = "doc-ajeno"
	if err := db.Create(ajeno).Error; err != nil {
		t.Fatal(err)
	}
	for _, d := range []domain.Decision{
		{DocID: "doc-l", Title: "Se corta una release por arreglo", Body: "Así sale antes", Origin: "doc"},
		{DocID: "doc-l", Title: "Las releases se juntan", Body: "Juntar las releases: una por cada arreglo gastaba números", Origin: "doc", SupersedesID: "dec-vieja"},
		{DocID: "doc-ajeno", Title: "Las releases de otros se juntan", Origin: "doc"},
	} {
		d := d
		d.ID = map[string]string{"Se corta una release por arreglo": "dec-vieja", "Las releases se juntan": "dec-nueva", "Las releases de otros se juntan": "dec-ajena"}[d.Title]
		d.DecidedAt = time.Now()
		if err := db.Create(&d).Error; err != nil {
			t.Fatal(err)
		}
	}
	r := NewSearchRepository(db)

	hits, err := r.Docs("releases juntan", "org-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Kind != domain.SearchDecision || hits[0].ID != "dec-nueva" {
		t.Fatalf("tenía que salir la decisión vigente, y sólo la de esta org: %+v", hits)
	}
	h := hits[0]
	if h.OwnerKind != "list" || h.OwnerID != "l" || !strings.Contains(h.Link, "tab=decisions") || !strings.HasPrefix(h.Where, "Lista") {
		t.Fatalf("un acierto tiene que decir de qué nodo es y abrir su pestaña: %+v", h)
	}
	if !strings.Contains(h.Snippet, "releases") {
		t.Fatalf("sin fragmento no se sabe por qué salió: %+v", h)
	}

	// La sustituida se encuentra por su texto, pero ya no vale: no sale.
	hits, err = r.Docs("corta arreglo", "org-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("una decisión sustituida no es lo que vale hoy: %+v", hits)
	}
}
