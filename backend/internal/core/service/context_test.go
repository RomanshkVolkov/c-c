package service

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// El mapa de contexto de un espacio (domain.ContextMap): lo que un agente lee
// antes de tocar nada, en una llamada y sin cuerpos.

func contextDB(t *testing.T) *gorm.DB {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("DB_HOST is set but the database does not answer (a skipped test is not a green one): %v", err)
	}
	const name = "cac_test_context_map"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Fatalf("DB_HOST is set but a throwaway database cannot be created: %v", err)
	}
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if a, _ := admin.DB(); a != nil {
			a.Close()
		}
	})
	if err := db.AutoMigrate(&domain.Organization{}, &domain.User{}, &domain.TaskSpace{}, &domain.TaskFolder{},
		&domain.TaskList{}, &domain.Item{}, &domain.ItemAssignee{}, &domain.Doc{}, &domain.DocTab{}, &domain.DocPage{},
		&domain.Decision{}, &domain.GitHubRepo{}, &domain.RepoDoc{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func mustCreate(t *testing.T, db *gorm.DB, v any) {
	t.Helper()
	if err := db.Create(v).Error; err != nil {
		t.Fatalf("%T: %v", v, err)
	}
}

// Un espacio «cac» de org-1 con una lista suelta de cliente («Backend») y una
// carpeta «Producto» con la lista «App», que tiene su documento; y un espacio
// de otra organización que no debe colarse.
func contextFixture(t *testing.T) *gorm.DB {
	db := contextDB(t)
	org := &domain.Organization{Name: "Dwit México"}
	org.ID = "org-1"
	mustCreate(t, db, org)
	proj := "proj-1"
	sp := &domain.TaskSpace{OrgID: "org-1", Name: "cac", Key: "cc", Rank: "0.5"}
	sp.ID = "sp-1"
	mustCreate(t, db, sp)
	ana := &domain.User{Username: "ana"}
	ana.ID = "u-ana"
	mustCreate(t, db, ana)
	otro := &domain.TaskSpace{OrgID: "org-2", Name: "otro", Rank: "0.5"}
	otro.ID = "sp-2"
	mustCreate(t, db, otro)
	f := &domain.TaskFolder{SpaceID: "sp-1", Name: "Producto", Rank: "0.5"}
	f.ID = "f-1"
	mustCreate(t, db, f)
	fid := "f-1"
	app := &domain.TaskList{SpaceID: "sp-1", FolderID: &fid, Name: "App", Rank: "0.5"}
	app.ID = "l-app"
	mustCreate(t, db, app)
	sub := &domain.TaskFolder{SpaceID: "sp-1", ParentFolderID: &fid, Name: "Diseño", Rank: "0.6"}
	sub.ID = "f-2"
	mustCreate(t, db, sub)
	subID := "f-2"
	marca := &domain.TaskList{SpaceID: "sp-1", FolderID: &subID, Name: "Marca", Rank: "0.5"}
	marca.ID = "l-marca"
	mustCreate(t, db, marca)
	back := &domain.TaskList{SpaceID: "sp-1", Name: "Backend", Rank: "0.5", ProjectID: &proj}
	back.ID = "l-back"
	mustCreate(t, db, back)

	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerList, OwnerID: "l-app"}
	doc.ID = "doc-app"
	mustCreate(t, db, doc)
	runbook := "## Despliegue\n\nCon el CI.\n\n```bash\n# no es un título\n```\n\n### Variables\n\n#### Demasiado hondo\n"
	for key, body := range map[domain.DocTabKey]string{domain.DocRunbook: runbook, domain.DocOverview: "# Qué es\n\nLa app.", domain.DocLinks: ""} {
		tab := &domain.DocTab{DocID: "doc-app", Key: key, Body: body}
		tab.ID = "tab-" + string(key)
		mustCreate(t, db, tab)
	}
	for i, title := range []string{"Vieja", "Nueva", "Más nueva"} {
		d := &domain.Decision{DocID: "doc-app", Title: title, Origin: "doc", DecidedAt: time.Now().Add(time.Duration(i) * time.Hour)}
		d.ID = fmt.Sprintf("dec-%d", i)
		if title == "Más nueva" {
			// Deja sin efecto a «Nueva»: el mapa enseña lo que vale hoy.
			d.SupersedesID = "dec-1"
		}
		mustCreate(t, db, d)
	}
	viva := &domain.DocPage{DocID: "doc-app", OrgID: "org-1", Title: "Arquitectura", Rank: "0.5"}
	viva.ID = "page-1"
	mustCreate(t, db, viva)
	papelera := &domain.DocPage{DocID: "doc-app", OrgID: "org-1", Title: "Borrada", Rank: "0.6"}
	papelera.ID = "page-2"
	mustCreate(t, db, papelera)
	db.Delete(&domain.DocPage{}, "id = ?", "page-2")

	for _, r := range []domain.GitHubRepo{
		{RepoID: 1, FullName: "guz-studio/cac", OrgID: "org-1", SpaceID: "sp-1", ShowDocs: true},
		{RepoID: 2, FullName: "guz-studio/suelto", OrgID: "org-1", ShowDocs: true},
		{RepoID: 3, FullName: "acme/x", OrgID: "org-2", SpaceID: "sp-2", ShowDocs: true},
	} {
		r := r
		r.ID = fmt.Sprintf("gh-%d", r.RepoID)
		mustCreate(t, db, &r)
	}
	rd := &domain.RepoDoc{OrgID: "org-1", RepoID: 1, Path: "README.md", Title: "cac", BlobSha: "x", Body: "# cac\n\nhola"}
	rd.ID = "rd-1"
	mustCreate(t, db, rd)
	// Del repo conectado pero sin espacio: no es de este espacio.
	suelto := &domain.RepoDoc{OrgID: "org-1", RepoID: 2, Path: "README.md", Title: "suelto", BlobSha: "y"}
	suelto.ID = "rd-2"
	mustCreate(t, db, suelto)

	parent := "it-curso"
	for _, it := range []domain.Item{
		{OrgID: "org-1", SpaceID: "sp-1", ListID: "l-app", Seq: 7, Title: "En curso", Status: domain.ReportInProgress,
			Handoff: "Falta la release", HandoffByID: "u-ana"},
		{OrgID: "org-1", SpaceID: "sp-1", ListID: "l-app", Seq: 8, Title: "Pendiente", Status: domain.ReportPending},
		{OrgID: "org-1", SpaceID: "sp-1", ListID: "l-app", Seq: 9, Title: "Subtarea", Status: domain.ReportInProgress, ParentID: &parent},
		{OrgID: "org-2", SpaceID: "sp-2", ListID: "l-otra", Seq: 1, Title: "De otra org", Status: domain.ReportInProgress},
	} {
		it := it
		it.ID = map[string]string{"En curso": "it-curso", "Pendiente": "it-pend", "Subtarea": "it-sub", "De otra org": "it-otra"}[it.Title]
		mustCreate(t, db, &it)
	}
	mustCreate(t, db, &domain.ItemAssignee{ItemID: "it-curso", UserID: "u-ana", Primary: true})
	return db
}

// Roturas que detecta, por orden de las comprobaciones: perder el orden o la
// ruta del árbol; no decir que una lista es de un cliente; enseñar cuerpos;
// tomar el `#` de un bloque de código por un título; pasar del nivel 3; sacar
// pestañas vacías; desordenar las pestañas; las decisiones viejas primero;
// enseñar páginas de la papelera; docs de repo de otro espacio; subtareas o
// tareas de otra organización entre lo que está en curso; una decisión
// sustituida como vigente; lo que está en curso sin su referencia, sin quién
// lo lleva o sin su «dónde quedó» (22-oct-2026: cada una obligaba a abrir la
// tarea).
func TestTheContextMapIsTheSpaceWithoutBodies(t *testing.T) {
	s := NewContextService(contextFixture(t))
	m, err := s.Map("org-1", "sp-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.Space.Name != "cac" || m.Space.OrgName != "Dwit México" {
		t.Fatalf("espacio: %+v", m.Space)
	}
	var paths []string
	for _, n := range m.Nodes {
		paths = append(paths, string(n.Kind)+" "+n.Path)
	}
	want := "space cac|list cac › Backend|folder cac › Producto|list cac › Producto › App|folder cac › Producto › Diseño|list cac › Producto › Diseño › Marca"
	if got := strings.Join(paths, "|"); got != want {
		t.Fatalf("árbol:\n got %s\nwant %s", got, want)
	}
	if m.Nodes[1].ProjectID != "proj-1" {
		t.Fatalf("la lista de cliente no lo dice: %+v", m.Nodes[1])
	}
	app := m.Nodes[3]
	if app.Doc == nil {
		t.Fatal("la lista App no trae su documento")
	}
	var tabs []string
	for _, tab := range app.Doc.Tabs {
		var hs []string
		for _, h := range tab.Headings {
			hs = append(hs, fmt.Sprintf("%d:%s", h.Level, h.Text))
		}
		tabs = append(tabs, string(tab.Key)+"="+strings.Join(hs, ","))
	}
	if got := strings.Join(tabs, " | "); got != "overview=1:Qué es | runbook=2:Despliegue,3:Variables" {
		t.Fatalf("pestañas: %s", got)
	}
	if app.Doc.Tabs[1].Chars == 0 {
		t.Fatal("sin tamaño, el agente no sabe si leerla entera")
	}
	if len(app.Doc.Decisions) != 2 || app.Doc.Decisions[0].Title != "Más nueva" || app.Doc.Decisions[1].Title != "Vieja" {
		t.Fatalf("decisiones (sólo las vigentes, la más reciente primero): %+v", app.Doc.Decisions)
	}
	if app.Doc.Decisions[0].ID != "dec-2" {
		t.Fatalf("una decisión sin id no se puede leer: %+v", app.Doc.Decisions[0])
	}
	if len(app.Doc.Pages) != 1 || app.Doc.Pages[0].Title != "Arquitectura" {
		t.Fatalf("páginas: %+v", app.Doc.Pages)
	}
	if m.Nodes[0].Doc != nil || m.Nodes[1].Doc != nil {
		t.Fatal("un nodo sin documento trae uno")
	}
	if len(m.RepoDocs) != 1 || m.RepoDocs[0].Repo != "guz-studio/cac" || m.RepoDocs[0].Path != "README.md" {
		t.Fatalf("docs del repo: %+v", m.RepoDocs)
	}
	if m.RepoDocs[0].Chars != len("# cac\n\nhola") {
		t.Fatalf("sin tamaño el agente no sabe si leer el .md entero: %+v", m.RepoDocs[0])
	}
	if len(m.InProgress) != 1 || m.InProgress[0].Title != "En curso" || m.InProgress[0].Seq != 7 {
		t.Fatalf("en curso: %+v", m.InProgress)
	}
	curso := m.InProgress[0]
	if curso.Ref != "cc-7" {
		t.Fatalf("sin referencia no se sabe cómo nombrarla en un commit: %+v", curso)
	}
	if len(curso.Assignees) != 1 || curso.Assignees[0] != "ana" {
		t.Fatalf("sin responsable no se sabe de quién es: %+v", curso)
	}
	if curso.Handoff != "Falta la release" || curso.HandoffBy != "ana" {
		t.Fatalf("el «dónde quedó» tiene que venir con quién lo escribió: %+v", curso)
	}
	if curso.UpdatedAt.IsZero() {
		t.Fatalf("sin fecha no se sabe si está vivo: %+v", curso)
	}
	if len(m.Truncated) != 0 {
		t.Fatalf("recortó sin pasarse: %v", m.Truncated)
	}
}

// Roturas que detectan: distinguir mayúsculas en el nombre del repo; dar por
// atado un repo conectado sin espacio; resolver un repo de una organización de
// la que no se es miembro.
func TestARepoResolvesToItsSpaceOnlyInYourOrgs(t *testing.T) {
	s := NewContextService(contextFixture(t))
	sp, org, err := s.ResolveRepo("Guz-Studio/CAC", []string{"org-2", "org-1"})
	if err != nil || sp != "sp-1" || org != "org-1" {
		t.Fatalf("resolver: %q %q %v", sp, org, err)
	}
	if _, _, err := s.ResolveRepo("guz-studio/suelto", []string{"org-1"}); !errors.Is(err, ErrContextRepoNotLinked) {
		t.Fatalf("un repo sin espacio se resolvió: %v", err)
	}
	if _, _, err := s.ResolveRepo("acme/x", []string{"org-1"}); !errors.Is(err, ErrContextRepoNotLinked) {
		t.Fatalf("un repo de otra org se resolvió: %v", err)
	}
}

// Rotura que detecta: pedir el mapa de un espacio de otra organización con el
// id de la tuya y que conteste.
func TestTheContextMapOfASpaceOfAnotherOrgIsNotFound(t *testing.T) {
	s := NewContextService(contextFixture(t))
	if _, err := s.Map("org-1", "sp-2", nil); err == nil {
		t.Fatal("el mapa cruzó organizaciones")
	}
}

// Lo que pasa del límite se recorta y se dice. Roturas que detecta: no
// recortar (un mapa que no cabe en el contexto), o recortar callado (el agente
// creería que no hay más).
func TestWhatTheMapLeavesOutItSays(t *testing.T) {
	db := contextFixture(t)
	for i := 0; i < domain.ContextMaxDecisions+3; i++ {
		d := &domain.Decision{DocID: "doc-app", Title: fmt.Sprintf("d%d", i), Origin: "doc", DecidedAt: time.Now().Add(-time.Duration(i+2) * time.Hour)}
		d.ID = fmt.Sprintf("dec-extra-%d", i)
		mustCreate(t, db, d)
	}
	m, err := NewContextService(db).Map("org-1", "sp-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	var app *domain.ContextNode
	for i := range m.Nodes {
		if m.Nodes[i].ID == "l-app" {
			app = &m.Nodes[i]
		}
	}
	// La primera es la vigente más reciente de la fixture («Más nueva»); «Nueva»
	// ya no cuenta, que la sustituyó ésa.
	if len(app.Doc.Decisions) != domain.ContextMaxDecisions || app.Doc.Decisions[0].Title != "Más nueva" {
		t.Fatalf("decisiones: %d, primera %q", len(app.Doc.Decisions), app.Doc.Decisions[0].Title)
	}
	if strings.Join(m.Truncated, ",") != "decisions" {
		t.Fatalf("no dice qué recortó: %v", m.Truncated)
	}
}

// El mapa se recorta y dice qué cambió desde una fecha (22-oct-2026). Un
// espacio grande son ~16 KB, y lo que se recortaba no tenía forma de pedirse;
// y la segunda sesión de una feature quiere saber qué pasó desde la primera,
// no releerlo todo.
//
// Roturas que detecta: `only` que no recorta (vuelve el mapa entero); `node`
// que no filtra; `since` que no filtra por fecha, o que deja fuera una de las
// cuatro cosas (tareas, decisiones, docs, .md); tareas cambiadas sin estado o
// sin referencia; pedir `since` sin «changes» en `only` y recibirlo igual.
func TestTheMapCanBeTrimmedAndSaysWhatChangedSince(t *testing.T) {
	s := NewContextService(contextFixture(t))

	// Sólo lo que está en curso: ni documentos ni .md.
	m, err := s.MapWith("org-1", "sp-1", nil, domain.ContextOptions{Only: []string{"inProgress"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range m.Nodes {
		if n.Doc != nil {
			t.Fatalf("only=inProgress trajo el documento de %s", n.Path)
		}
	}
	if len(m.RepoDocs) != 0 || len(m.InProgress) != 1 || m.Changes != nil {
		t.Fatalf("only=inProgress: repoDocs %d, inProgress %d, changes %v", len(m.RepoDocs), len(m.InProgress), m.Changes)
	}

	// Sólo el documento de un nodo.
	m, err = s.MapWith("org-1", "sp-1", nil, domain.ContextOptions{Node: "sp-1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range m.Nodes {
		if n.Doc != nil {
			t.Fatalf("node=sp-1 (sin documento) trajo el de %s", n.Path)
		}
	}

	// Lo que cambió desde hace un minuto: todo lo de la fixture que es de este
	// espacio y está vivo.
	hace := time.Now().Add(-time.Minute)
	m, err = s.MapWith("org-1", "sp-1", nil, domain.ContextOptions{Since: &hace})
	if err != nil {
		t.Fatal(err)
	}
	if m.Changes == nil {
		t.Fatal("con since tiene que venir changes")
	}
	var titles []string
	for _, x := range m.Changes.Tasks {
		titles = append(titles, x.Title+"="+x.Status+"@"+x.Ref)
	}
	slices.Sort(titles)
	if got := strings.Join(titles, "|"); got != "En curso=in_progress@cc-7|Pendiente=pending@cc-8" {
		t.Fatalf("tareas cambiadas (sin subtareas ni las de otra org, con estado y ref): %s", got)
	}
	if len(m.Changes.Decisions) != 3 || m.Changes.Decisions[0].Title != "Más nueva" || m.Changes.Decisions[0].Path != "cac › Producto › App" {
		t.Fatalf("decisiones cambiadas, con su nodo: %+v", m.Changes.Decisions)
	}
	var docs []string
	for _, d := range m.Changes.Docs {
		docs = append(docs, string(d.Tab)+d.PageTitle+"@"+d.Path)
	}
	slices.Sort(docs)
	if got := strings.Join(docs, "|"); got != "Arquitectura@cac › Producto › App|overview@cac › Producto › App|runbook@cac › Producto › App" {
		t.Fatalf("docs editados (pestañas con texto y páginas vivas): %s", got)
	}
	if len(m.Changes.RepoDocs) != 1 || m.Changes.RepoDocs[0].Path != "README.md" {
		t.Fatalf(".md cambiados: %+v", m.Changes.RepoDocs)
	}

	// Desde dentro de tres horas (la fixture tiene decisiones fechadas una y
	// dos horas en el futuro): nada, pero se dice.
	luego := time.Now().Add(3 * time.Hour)
	m, err = s.MapWith("org-1", "sp-1", nil, domain.ContextOptions{Since: &luego})
	if err != nil {
		t.Fatal(err)
	}
	if m.Changes == nil || len(m.Changes.Tasks)+len(m.Changes.Decisions)+len(m.Changes.Docs)+len(m.Changes.RepoDocs) != 0 {
		t.Fatalf("desde el futuro no ha cambiado nada: %+v", m.Changes)
	}

	// `since` sin pedir «changes» en `only`: no viene.
	m, err = s.MapWith("org-1", "sp-1", nil, domain.ContextOptions{Since: &hace, Only: []string{"tree"}})
	if err != nil {
		t.Fatal(err)
	}
	if m.Changes != nil {
		t.Fatal("only=tree con since trajo changes")
	}
}
