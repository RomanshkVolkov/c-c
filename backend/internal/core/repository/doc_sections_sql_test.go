package repository

import (
	"fmt"
	"strings"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

func sectionsSQLDB(t *testing.T) *gorm.DB {
	t.Helper()
	if GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			GetEnv("DB_HOST", "localhost"), GetEnv("DB_PORT", "5432"),
			GetEnv("DB_USER", "postgres"), GetEnv("DB_PASSWORD", ""),
			name, GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("DB_HOST is set but the database does not answer (a skipped test is not a green one): %v", err)
	}
	const name = "cac_test_doc_sections"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Fatalf("DB_HOST is set but a throwaway database cannot be created: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})
	if err := db.AutoMigrate(
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.User{},
		&domain.Doc{}, &domain.DocTab{}, &domain.DocVersion{}, &domain.DocAttachment{},
		&domain.DocPage{}, &domain.DocPageVersion{}, &domain.DocSection{}, &domain.Item{},
	); err != nil {
		t.Fatal(err)
	}
	return db
}

// sectionState: las secciones de una pestaña o página como «id título» (las
// vivas, en orden) y las borradas aparte.
func sectionState(t *testing.T, db *gorm.DB, o sectionOwner) (live []string, ids map[string]string, removed []string) {
	t.Helper()
	var rows []domain.DocSection
	if err := o.scope(db.Model(&domain.DocSection{})).Order("ordinal").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	ids = map[string]string{}
	for _, s := range rows {
		if s.RemovedAt != nil {
			removed = append(removed, s.Heading)
			ids["-"+s.Heading] = s.ID
			continue
		}
		live = append(live, s.Heading)
		ids[s.Heading] = s.ID
	}
	return live, ids, removed
}

// inStep: las secciones vivas son exactamente los títulos del cuerpo. Es la
// guarda de que **toda** escritura reconcilia: un camino nuevo que se olvide
// deja filas que no casan con su cuerpo.
func inStep(t *testing.T, what string, live []string, body string) {
	t.Helper()
	var want []string
	for _, p := range domain.SplitSections(body) {
		want = append(want, p.Heading)
	}
	if strings.Join(live, "|") != strings.Join(want, "|") {
		t.Fatalf("%s: secciones %v, el cuerpo tiene %v", what, live, want)
	}
}

func tabBody(t *testing.T, db *gorm.DB, docID string, key domain.DocTabKey) string {
	t.Helper()
	var tab domain.DocTab
	if err := db.Where("doc_id = ? AND key = ?", docID, key).First(&tab).Error; err != nil {
		t.Fatal(err)
	}
	return tab.Body
}

const sectionRunbook = "## Desplegar\n\nEl push a main construye y despliega en k8s\n\n## Volver atrás\n\nkubectl rollout undo del deployment\n"

func TestEveryTabWriteKeepsItsSectionsAndTheirIDs(t *testing.T) {
	db := sectionsSQLDB(t)
	r := NewDocRepository(db)
	key := domain.DocRunbook

	doc, err := r.SaveTab("org-1", domain.DocOwnerList, "list-1", key, sectionRunbook, "u1")
	if err != nil {
		t.Fatal(err)
	}
	o := tabOwner(doc, key)
	live, first, _ := sectionState(t, db, o)
	inStep(t, "al crear", live, sectionRunbook)

	// Renombrar: el mismo texto debajo, el mismo id.
	renamed := strings.Replace(sectionRunbook, "## Volver atrás", "## Deshacer un despliegue", 1)
	if _, err := r.SaveTab("org-1", domain.DocOwnerList, "list-1", key, renamed, "u1"); err != nil {
		t.Fatal(err)
	}
	live, ids, _ := sectionState(t, db, o)
	inStep(t, "al renombrar", live, renamed)
	if ids["Deshacer un despliegue"] != first["Volver atrás"] || ids["Desplegar"] != first["Desplegar"] {
		t.Fatalf("renombrar cambió el id: %v → %v", first, ids)
	}

	// Añadir al final, y a una sección.
	if _, err := r.AppendTab("org-1", domain.DocOwnerList, "list-1", key, "## Costes\n\ncontabo", "u1"); err != nil {
		t.Fatal(err)
	}
	live, _, _ = sectionState(t, db, o)
	inStep(t, "al añadir", live, tabBody(t, db, doc.ID, key))
	if _, err := r.AppendTabSection("org-1", domain.DocOwnerList, "list-1", key, "Trampas", "- una", "u1"); err != nil {
		t.Fatal(err)
	}
	live, ids, _ = sectionState(t, db, o)
	inStep(t, "al añadir a una sección", live, tabBody(t, db, doc.ID, key))
	if ids["Desplegar"] != first["Desplegar"] {
		t.Fatal("añadir cambió un id que no tocaba")
	}

	// Quitar una: queda marcada con su último título.
	sin := "## Desplegar\n\nEl push a main construye y despliega en k8s\n"
	if _, err := r.SaveTab("org-1", domain.DocOwnerList, "list-1", key, sin, "u1"); err != nil {
		t.Fatal(err)
	}
	live, _, removed := sectionState(t, db, o)
	inStep(t, "al quitar", live, sin)
	if !strings.Contains(strings.Join(removed, "|"), "Deshacer un despliegue") {
		t.Fatalf("la quitada no quedó marcada con su título: %v", removed)
	}

	// Volver a la versión de antes la revive con el mismo id.
	if _, err := r.SaveTab("org-1", domain.DocOwnerList, "list-1", key, renamed, "u1"); err != nil {
		t.Fatal(err)
	}
	live, ids, _ = sectionState(t, db, o)
	inStep(t, "al restaurar", live, renamed)
	if ids["Deshacer un despliegue"] != first["Volver atrás"] {
		t.Fatal("restaurar creó otra sección en vez de revivir la vieja")
	}

	// Un renombre declarado conserva el id aunque cambie todo el texto.
	other := "## Desplegar\n\nEl push a main construye y despliega en k8s\n\n## Plan B\n\notra cosa completamente distinta\n"
	if _, err := r.SaveTabRenaming("org-1", domain.DocOwnerList, "list-1", key, other, "u1",
		map[string]string{first["Volver atrás"]: "Plan B"}); err != nil {
		t.Fatal(err)
	}
	_, ids, _ = sectionState(t, db, o)
	if ids["Plan B"] != first["Volver atrás"] {
		t.Fatal("el renombre declarado no conservó el id")
	}

	// Y la pestaña sale con sus secciones y sus ids.
	tabs, err := r.Tabs(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tab := range tabs {
		if tab.Key == key && (len(tab.Sections) != 2 || tab.Sections[1].ID != first["Volver atrás"] || tab.Sections[1].Index != 1) {
			t.Fatalf("la pestaña no lleva sus secciones: %+v", tab.Sections)
		}
	}
}

func TestEveryPageWriteKeepsItsSectionsAndTheirIDs(t *testing.T) {
	db := sectionsSQLDB(t)
	r := NewDocRepository(db)
	p, err := r.CreatePage("org-1", domain.DocOwnerList, "list-1",
		domain.CreateDocPageRequest{Title: "Guía", Body: sectionRunbook}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	o := pageOwner(p)
	live, first, _ := sectionState(t, db, o)
	inStep(t, "al crear", live, sectionRunbook)

	renamed := strings.Replace(sectionRunbook, "## Volver atrás", "## Deshacer", 1)
	if err := r.SavePage(p, nil, &renamed, "u1"); err != nil {
		t.Fatal(err)
	}
	live, ids, _ := sectionState(t, db, o)
	inStep(t, "al guardar", live, renamed)
	if ids["Deshacer"] != first["Volver atrás"] {
		t.Fatal("renombrar en una página cambió el id")
	}

	if err := r.AppendPage(p.ID, "## Costes\n\ncontabo", "u1"); err != nil {
		t.Fatal(err)
	}
	fresh, _ := r.FindPage(p.DocID, p.ID)
	live, _, _ = sectionState(t, db, o)
	inStep(t, "al añadir", live, fresh.Body)

	other := "## Desplegar\n\nEl push a main construye y despliega en k8s\n\n## Plan B\n\nnada que ver\n"
	if err := r.SavePageRenaming(fresh, nil, &other, "u1", map[string]string{first["Volver atrás"]: "Plan B"}); err != nil {
		t.Fatal(err)
	}
	_, ids, _ = sectionState(t, db, o)
	if ids["Plan B"] != first["Volver atrás"] {
		t.Fatal("el renombre declarado no conservó el id en una página")
	}
	secs, err := r.PageSections(p.DocID, p.ID)
	if err != nil || len(secs) != 2 || secs[1].ID != first["Volver atrás"] {
		t.Fatalf("la página no lleva sus secciones: %+v %v", secs, err)
	}
}

// Lo de antes de las secciones recibe su identidad al arrancar, una vez.
func TestOldTabsAndPagesGetSectionsOnceAtStartup(t *testing.T) {
	db := sectionsSQLDB(t)
	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerList, OwnerID: "list-1"}
	db.Create(doc)
	db.Create(&domain.DocTab{DocID: doc.ID, Key: domain.DocRunbook, Body: sectionRunbook})
	page := &domain.DocPage{DocID: doc.ID, OrgID: "org-1", Title: "P", Body: "## Uno\n\na\n"}
	db.Create(page)
	// Una página en la papelera también: restaurarla tiene que encontrarlas.
	gone := &domain.DocPage{DocID: doc.ID, OrgID: "org-1", Title: "Q", Body: "## Dos\n\nb\n"}
	db.Create(gone)
	db.Delete(gone)

	backfillDocSections(db)
	backfillDocSections(db)

	live, _, _ := sectionState(t, db, tabOwner(doc, domain.DocRunbook))
	inStep(t, "pestaña", live, sectionRunbook)
	live, _, _ = sectionState(t, db, pageOwner(page))
	inStep(t, "página", live, page.Body)
	live, _, _ = sectionState(t, db, pageOwner(gone))
	inStep(t, "página en la papelera", live, gone.Body)

	// Otro pod escribió entre la consulta y el bloqueo: no se duplica.
	if err := backfillTabSections(db, pendingTab{ID: tabID(t, db, doc.ID), DocID: doc.ID, OrgID: "org-1", Key: domain.DocRunbook}); err != nil {
		t.Fatal(err)
	}
	if err := backfillPageSections(db, page.ID); err != nil {
		t.Fatal(err)
	}
	live, _, _ = sectionState(t, db, tabOwner(doc, domain.DocRunbook))
	inStep(t, "pestaña, otra vez", live, sectionRunbook)
	live, _, _ = sectionState(t, db, pageOwner(page))
	inStep(t, "página, otra vez", live, page.Body)
}

func tabID(t *testing.T, db *gorm.DB, docID string) string {
	t.Helper()
	var tab domain.DocTab
	if err := db.Where("doc_id = ?", docID).First(&tab).Error; err != nil {
		t.Fatal(err)
	}
	return tab.ID
}

// Si las secciones no se pueden escribir, lo que alguien escribió se guarda
// igual: perderlo es peor que una identidad atrasada.
func TestASectionFailureDoesNotLoseTheWrite(t *testing.T) {
	db := sectionsSQLDB(t)
	r := NewDocRepository(db)
	if err := db.Migrator().DropTable(&domain.DocSection{}); err != nil {
		t.Fatal(err)
	}
	doc, err := r.SaveTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, sectionRunbook, "u1")
	if err != nil {
		t.Fatalf("el guardado falló por las secciones: %v", err)
	}
	if tabBody(t, db, doc.ID, domain.DocRunbook) != sectionRunbook {
		t.Fatal("el texto no quedó guardado")
	}
	if _, err := r.AppendTab("org-1", domain.DocOwnerList, "list-1", domain.DocRunbook, "más", "u1"); err != nil {
		t.Fatalf("añadir falló por las secciones: %v", err)
	}
}
