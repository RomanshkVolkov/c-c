package service

import (
	"errors"
	"testing"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una decisión se aplica a varias tareas y secciones (command-and-control-91).

const linkRunbook = "## Desplegar\n\nEl push a main construye y despliega\n\n## Volver atrás\n\nkubectl rollout undo\n"

// sectionID: el id de la sección `heading` de una pestaña.
func sectionID(t *testing.T, svc *DocService, docID string, key domain.DocTabKey, heading string) string {
	t.Helper()
	tabs, err := svc.Tabs(docID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tab := range tabs {
		if tab.Key != key {
			continue
		}
		for _, s := range tab.Sections {
			if s.Heading == heading {
				return s.ID
			}
		}
	}
	t.Fatalf("no hay sección %q", heading)
	return ""
}

// rewrite: reescribe el runbook de list-1 sin pasar por el hash del servicio,
// como lo haría quien acaba de leerlo.
func rewrite(t *testing.T, db *gorm.DB, body string) {
	t.Helper()
	if _, err := repository.NewDocRepository(db).SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, body, "u1"); err != nil {
		t.Fatal(err)
	}
}

func linkKinds(d *domain.Decision) map[string]domain.DecisionLinkView {
	out := map[string]domain.DecisionLinkView{}
	for _, l := range d.Links {
		if l.Kind == domain.DecisionLinkTask {
			out["task:"+l.TaskID] = l
		} else {
			out["section:"+l.Heading] = l
		}
	}
	return out
}

func decisionCount(t *testing.T, db *gorm.DB) int64 {
	t.Helper()
	var n int64
	db.Model(&domain.Decision{}).Count(&n)
	return n
}

func TestADecisionLinksSeveralTasksAndSectionsOfItsOrg(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	extra := &domain.Item{OrgID: "org-1", ListID: "list-1", Title: "otra", Status: domain.ReportPending}
	extra.ID = "task-otra"
	db.Create(extra)
	svc := NewDocService(repository.NewDocRepository(db))
	doc, err := svc.SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, linkRunbook, "u1", nil)
	if err != nil {
		t.Fatal(err)
	}
	volver := sectionID(t, svc, doc.ID, domain.DocRunbook, "Volver atrás")

	d, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{
		Title: "Se vuelve atrás con rollout undo", Origin: "task", OriginTaskID: "task-aqui",
		TaskIDs: []string{"task-otra"}, SectionIDs: []string{volver},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := svc.Decision(d.ID)
	k := linkKinds(got)
	if len(got.Links) != 3 || k["task:task-aqui"].ID == "" || k["task:task-otra"].TaskTitle != "otra" ||
		k["section:Volver atrás"].Tab != domain.DocRunbook || k["section:Volver atrás"].OwnerID != "list-1" {
		t.Fatalf("enlaces: %+v", got.Links)
	}

	// La sección dice qué decisión la sostiene; la tarea, también.
	tabs, _ := svc.Tabs(doc.ID)
	for _, tab := range tabs {
		for _, s := range tab.Sections {
			want := 0
			if s.ID == volver {
				want = 1
			}
			if len(s.Decisions) != want {
				t.Fatalf("la sección %q tiene %d decisiones, se esperaban %d", s.Heading, len(s.Decisions), want)
			}
		}
	}
	repo := repository.NewDocRepository(db)
	if ds, _ := repo.TaskDecisions("task-otra"); len(ds) != 1 || ds[0].ID != d.ID || ds[0].OwnerID != "list-1" {
		t.Fatalf("la tarea no dice su decisión: %+v", ds)
	}
}

func TestADecisionCannotLinkWhatIsNotItsOrgOrGone(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))
	doc, _ := svc.SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, linkRunbook, "u1", nil)
	ajenaDoc, _ := svc.SaveTab("org-2", domain.DocOwnerList, "list-2", domain.DocRunbook, linkRunbook, "u2", nil)
	ajena := sectionID(t, svc, ajenaDoc.ID, domain.DocRunbook, "Desplegar")
	quitada := sectionID(t, svc, doc.ID, domain.DocRunbook, "Volver atrás")
	rewrite(t, db, "## Desplegar\n\nEl push a main construye y despliega\n")

	for name, req := range map[string]domain.DecisionRequest{
		"tarea de otra org":   {TaskIDs: []string{"task-ajena"}},
		"tarea borrada":       {TaskIDs: []string{"task-borrada"}},
		"tarea inventada":     {TaskIDs: []string{"no-existe"}},
		"sección de otra org": {SectionIDs: []string{ajena}},
		"sección quitada":     {SectionIDs: []string{quitada}},
	} {
		before := decisionCount(t, db)
		req.Title, req.Origin = "x", "doc"
		if _, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", req); !errors.Is(err, ErrDecisionLinkNotHere) {
			t.Errorf("%s: %v", name, err)
		}
		if decisionCount(t, db) != before {
			t.Errorf("%s: la decisión quedó escrita sin su enlace", name)
		}
	}

	d, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{Title: "y", Origin: "doc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.LinkDecision(d.ID, "org-1", "u1", "", domain.DecisionLinksRequest{TaskIDs: []string{"task-ajena"}}); !errors.Is(err, ErrDecisionLinkNotHere) {
		t.Errorf("enlazar después a una tarea ajena: %v", err)
	}
	if err := svc.LinkDecision(d.ID, "org-1", "u1", "", domain.DecisionLinksRequest{SectionIDs: []string{quitada}}); !errors.Is(err, ErrDecisionLinkNotHere) {
		t.Errorf("enlazar después a una sección quitada: %v", err)
	}
}

func TestLinksAreAddedOnceAndRemovedWithoutBeingDeleted(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))
	d, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{Title: "z", Origin: "doc"})
	if err != nil {
		t.Fatal(err)
	}
	add := domain.DecisionLinksRequest{TaskIDs: []string{"task-aqui", "task-aqui"}}
	for range 2 {
		if err := svc.LinkDecision(d.ID, "org-1", "u1", "mcp", add); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := svc.Decision(d.ID)
	if len(got.Links) != 1 || got.Links[0].Via != "mcp" {
		t.Fatalf("enlazar dos veces lo mismo lo repitió: %+v", got.Links)
	}

	link := got.Links[0].ID
	if err := svc.UnlinkDecision(d.ID, link, "u2"); err != nil {
		t.Fatal(err)
	}
	got, _ = svc.Decision(d.ID)
	if len(got.Links) != 0 {
		t.Fatalf("el enlace quitado sigue saliendo: %+v", got.Links)
	}
	var row domain.DecisionLink
	if err := db.Where("id = ?", link).First(&row).Error; err != nil || row.RemovedAt == nil || row.RemovedByID != "u2" {
		t.Fatalf("quitar borró el enlace o no dijo quién: %+v %v", row, err)
	}
	if err := svc.UnlinkDecision(d.ID, link, "u2"); !errors.Is(err, repository.ErrDecisionLinkNotFound) {
		t.Errorf("quitar dos veces: %v", err)
	}
	// Un enlace de otra decisión no se quita desde ésta.
	other, _ := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{
		Title: "w", Origin: "doc", TaskIDs: []string{"task-aqui"}})
	otherGot, _ := svc.Decision(other.ID)
	if err := svc.UnlinkDecision(d.ID, otherGot.Links[0].ID, "u2"); !errors.Is(err, repository.ErrDecisionLinkNotFound) {
		t.Errorf("se quitó el enlace de otra decisión: %v", err)
	}

	// Y se puede volver a enlazar lo que se quitó.
	if err := svc.LinkDecision(d.ID, "org-1", "u1", "", add); err != nil {
		t.Fatal(err)
	}
	if got, _ = svc.Decision(d.ID); len(got.Links) != 1 {
		t.Fatalf("no se pudo volver a enlazar: %+v", got.Links)
	}
}

func TestASupersededDecisionLeavesTheSectionButNotTheTask(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))
	doc, _ := svc.SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, linkRunbook, "u1", nil)
	sec := sectionID(t, svc, doc.ID, domain.DocRunbook, "Desplegar")
	old, _ := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{
		Title: "vieja", Origin: "doc", TaskIDs: []string{"task-aqui"}, SectionIDs: []string{sec}})
	nueva, err := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{
		Title: "nueva", Origin: "doc", Supersedes: old.ID, SectionIDs: []string{sec}})
	if err != nil {
		t.Fatal(err)
	}
	repo := repository.NewDocRepository(db)
	by, _ := repo.SectionDecisions([]string{sec})
	if len(by[sec]) != 1 || by[sec][0].ID != nueva.ID {
		t.Fatalf("la sección sigue diciendo la sustituida: %+v", by[sec])
	}
	ds, _ := repo.TaskDecisions("task-aqui")
	if len(ds) != 1 || ds[0].ID != old.ID || ds[0].SupersededByID != nueva.ID {
		t.Fatalf("la tarea perdió su decisión o no dice que se sustituyó: %+v", ds)
	}
}

func TestALinkToARemovedSectionSaysWhatItWasCalled(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))
	doc, _ := svc.SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, linkRunbook, "u1", nil)
	sec := sectionID(t, svc, doc.ID, domain.DocRunbook, "Volver atrás")
	d, _ := svc.AddDecision("org-1", domain.DocOwnerList, "list-1", "u1", "", "", domain.DecisionRequest{
		Title: "x", Origin: "doc", SectionIDs: []string{sec}})
	rewrite(t, db, "## Desplegar\n\nEl push a main construye y despliega\n")
	got, _ := svc.Decision(d.ID)
	if len(got.Links) != 1 || !got.Links[0].SectionRemoved || got.Links[0].Heading != "Volver atrás" {
		t.Fatalf("%+v", got.Links)
	}
}

// Una decisión no queda escrita sin aquello a lo que dice aplicarse: si un
// enlace no entra, tampoco ella.
func TestADecisionIsNotWrittenWithoutItsLinks(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	repo := repository.NewDocRepository(db)
	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerList, OwnerID: "list-1"}
	db.Create(doc)
	tooLong := "una-tarea-con-un-id-mas-largo-que-la-columna"
	if _, err := repo.AddDecisionWithLinks(&domain.Decision{DocID: doc.ID, Title: "x", Origin: "doc"},
		"org-1", []string{tooLong}, nil); err == nil {
		t.Fatal("un enlace imposible entró")
	}
	if decisionCount(t, db) != 0 {
		t.Fatal("la decisión quedó escrita sin su enlace")
	}
}

func TestOldDecisionsGetTheirOriginTaskAsALinkOnce(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerList, OwnerID: "list-1"}
	db.Create(doc)
	old := &domain.Decision{DocID: doc.ID, Title: "de antes", Origin: domain.DecisionFromTask, OriginTaskID: "task-aqui"}
	db.Create(old)
	gone := &domain.Decision{DocID: doc.ID, Title: "de una borrada", Origin: domain.DecisionFromTask, OriginTaskID: "task-borrada"}
	db.Create(gone)
	repository.BackfillDecisionOriginLinks(db)
	repository.BackfillDecisionOriginLinks(db)
	var links []domain.DecisionLink
	db.Find(&links)
	if len(links) != 1 || *links[0].TaskID != "task-aqui" || links[0].OrgID != "org-1" {
		t.Fatalf("%+v", links)
	}
}

func TestSectionsAreFoundByTitleWithinTheOrg(t *testing.T) {
	db, cleanup := decisionDB(t)
	defer cleanup()
	svc := NewDocService(repository.NewDocRepository(db))
	svc.SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, linkRunbook+"\n## 100% seguro\n\nx\n", "u1", nil)
	svc.SaveTab("org-2", domain.DocOwnerList, "list-2", domain.DocRunbook, linkRunbook, "u2", nil)
	hits, err := svc.SearchSections("org-1", "VOLVER")
	if err != nil || len(hits) != 1 || hits[0].Heading != "Volver atrás" || hits[0].OwnerID != "list-1" || hits[0].Tab != domain.DocRunbook {
		t.Fatalf("%+v %v", hits, err)
	}
	// Un % es una letra, no un comodín.
	if hits, _ := svc.SearchSections("org-1", "%"); len(hits) != 1 {
		t.Fatalf("el %% se tomó por comodín: %+v", hits)
	}
	// Una quitada ya no se ofrece.
	rewrite(t, db, "## Desplegar\n\nEl push\n")
	if hits, _ := svc.SearchSections("org-1", "volver"); len(hits) != 0 {
		t.Fatalf("%+v", hits)
	}
}
