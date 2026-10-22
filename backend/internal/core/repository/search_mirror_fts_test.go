package repository

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Una página que es copia de un .md atado al espacio no sale en la búsqueda:
// manda el repo (22-oct-2026). En Proteus cada doc estaba dos veces y con
// límite 8 llegaban 4 distintos.
//
// Roturas que detecta: devolver la copia; callar también la página que **no**
// es copia (otro texto); o dejar de encontrar el .md.
func TestAPageThatMirrorsARepoDocIsNotASecondHit(t *testing.T) {
	db := searchFTSDB(t)
	must := func(v any) {
		t.Helper()
		if err := db.Create(v).Error; err != nil {
			t.Fatal(err)
		}
	}
	sp := &domain.TaskSpace{OrgID: "org-1", Name: "Espacio", Rank: "0.5"}
	sp.ID = "s"
	must(sp)
	gr := &domain.GitHubRepo{RepoID: 1, FullName: "dwit/handover", OrgID: "org-1", SpaceID: "s", ShowDocs: true}
	gr.ID = "gh-1"
	must(gr)
	rd := &domain.RepoDoc{OrgID: "org-1", RepoID: 1, Path: "docs/nomina.md", Title: "Nómina", BlobSha: "x", Body: "# Nómina\n\nLa nómina quincenal sale del banco."}
	rd.ID = "rd-nomina"
	must(rd)
	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerList, OwnerID: "l"}
	doc.ID = "doc-l"
	must(doc)
	espejo := &domain.DocPage{DocID: "doc-l", OrgID: "org-1", Title: "Nómina", Rank: "0.5", Body: rd.Body}
	espejo.ID = "page-espejo"
	must(espejo)
	propia := &domain.DocPage{DocID: "doc-l", OrgID: "org-1", Title: "Nómina, lo nuestro", Rank: "0.6", Body: "La nómina la revisa Diego los lunes."}
	propia.ID = "page-propia"
	must(propia)

	hits, err := NewSearchRepository(db).Docs("nómina", "org-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, h := range hits {
		ids[h.ID] = true
	}
	if ids["page-espejo"] {
		t.Fatalf("la copia de un .md atado salió como acierto aparte: %v", hitIDs(hits))
	}
	if !ids["page-propia"] || !ids["rd-nomina"] {
		t.Fatalf("tenían que salir el .md y la página con texto propio: %v", hitIDs(hits))
	}
}
