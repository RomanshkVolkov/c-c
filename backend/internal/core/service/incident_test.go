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

// El registro de lo que mordió (domain.Incident, command-and-control-289):
// que lo encuentre quien toca el servidor o el área, aunque no sepa en qué
// tarea pasó.

func incidentDB(t *testing.T) *gorm.DB {
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
	const name = "cac_test_incidents"
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
	if err := db.AutoMigrate(&domain.Organization{}, &domain.User{}, &domain.Server{}, &domain.TaskSpace{},
		&domain.TaskFolder{}, &domain.TaskList{}, &domain.Item{}, &domain.ItemAssignee{}, &domain.ItemBlock{},
		&domain.Doc{}, &domain.DocTab{}, &domain.DocVersion{}, &domain.DocPage{}, &domain.DocSection{},
		&domain.Decision{}, &domain.DecisionLink{}, &domain.GitHubRepo{}, &domain.RepoDoc{}, &domain.TaskGitLink{},
		&domain.ReportProject{},
		&domain.Incident{}, &domain.IncidentServer{}, &domain.IncidentArea{}, &domain.IncidentCommit{}, &domain.IncidentGuard{},
	); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureSearchIndexes(db); err != nil {
		t.Fatal(err)
	}

	// org-1: el espacio «cac» (clave cc) con la lista Backend, y los
	// servidores gstd y pixel-vps. org-2: su espacio y su servidor boaty.
	for _, o := range []string{"org-1", "org-2"} {
		org := &domain.Organization{Name: o, Slug: o}
		org.ID = o
		mustCreate(t, db, org)
	}
	for _, x := range []struct{ id, org, name, key string }{{"sp-1", "org-1", "cac", "cc"}, {"sp-2", "org-2", "otro", "ot"}} {
		sp := &domain.TaskSpace{OrgID: x.org, Name: x.name, Key: x.key, Rank: "0.5"}
		sp.ID = x.id
		mustCreate(t, db, sp)
	}
	for _, x := range []struct{ id, space string }{{"l-back", "sp-1"}, {"l-app", "sp-1"}, {"l-otro", "sp-2"}} {
		l := &domain.TaskList{SpaceID: x.space, Name: x.id, Rank: "0.5"}
		l.ID = x.id
		mustCreate(t, db, l)
	}
	for _, x := range []struct{ id, org, name string }{
		{"srv-gstd", "org-1", "gstd"}, {"srv-pixel", "org-1", "pixel-vps"}, {"srv-boaty", "org-2", "boaty"},
	} {
		s := &domain.Server{OrgID: x.org, Name: x.name, Host: "10.0.0.1", SSHUser: "root", Type: domain.ServerTypeDockerSwarm}
		s.ID = x.id
		mustCreate(t, db, s)
	}
	for _, x := range []struct{ id, org string }{{"task-283", "org-1"}, {"task-ajena", "org-2"}} {
		it := &domain.Item{OrgID: x.org, ListID: "l-back", Title: "simulacro", Status: domain.ReportPending, Seq: 283}
		it.ID = x.id
		mustCreate(t, db, it)
	}
	mustCreate(t, db, &domain.TaskGitLink{OrgID: "org-1", ItemID: "task-283", RepoID: 1,
		RepoFullName: "RomanshkVolkov/c-c", Kind: "commit", Key: "5397e32c0e5262dcb3cfeb0ca973f2c790a8e054",
		Title: "fix(ansible): cert-manager v1.21.3", HTMLURL: "https://github.com/RomanshkVolkov/c-c/commit/5397e32"})
	return db
}

func incidentSvc(db *gorm.DB) *IncidentService {
	return NewIncidentService(repository.NewIncidentRepository(db), repository.NewDocRepository(db))
}

func record(t *testing.T, svc *IncidentService, owner string, req domain.IncidentRequest) *domain.Incident {
	t.Helper()
	in, err := svc.Record("org-1", domain.DocOwnerList, owner, "u-1", domain.ViaMCP, req)
	if err != nil {
		t.Fatalf("record %q: %v", req.Title, err)
	}
	return in
}

func hitIDs(hits []domain.SearchHit, kind domain.SearchKind) []string {
	var out []string
	for _, h := range hits {
		if h.Kind == kind {
			out = append(out, h.ID)
		}
	}
	return out
}

// Lo que pide jose: quien toca gstd encuentra lo que mordió en gstd sin saber
// que pasó en la 283, y aunque el cuerpo no diga «gstd».
//
// Roturas que atrapa: quitar `keywords` de la columna de búsqueda, no llamar a
// `refreshKeywords` al guardar, o no sumar los incidentes a la búsqueda.
func TestAnIncidentIsFoundByItsServerAndAreaEvenIfItsTextDoesNotNameThem(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	in := record(t, svc, "l-back", domain.IncidentRequest{
		Title:   "El reto DNS-01 no se limpia y el certificado no sale",
		Body:    "`DELETE /zones//dns_records` → 7003 en Cloudflare.",
		Servers: []string{"GSTD"}, Areas: []string{"Cert Manager"},
	})
	search := repository.NewSearchRepository(db)
	for _, q := range []string{"gstd", "cert-manager", "certificado"} {
		hits, err := search.Docs(q, "org-1", 8)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(hitIDs(hits, domain.SearchIncident), in.ID) {
			t.Errorf("buscar %q no trae el incidente: %+v", q, hits)
		}
	}
	hits, _ := search.Docs("pixel", "org-1", 8)
	if slices.Contains(hitIDs(hits, domain.SearchIncident), in.ID) {
		t.Error("buscar pixel-vps trae un incidente de gstd")
	}
	if hits, _ := search.Docs("gstd", "org-2", 8); len(hitIDs(hits, domain.SearchIncident)) != 0 {
		t.Error("otra organización encuentra el incidente")
	}
	if len(in.Areas) != 1 || in.Areas[0] != "cert-manager" {
		t.Errorf("el área no se normalizó: %v", in.Areas)
	}
	if len(in.Servers) != 1 || in.Servers[0].ID != "srv-gstd" {
		t.Errorf("el servidor no se resolvió por nombre sin mayúsculas: %v", in.Servers)
	}
}

// Lo escrito no se edita, así que lo que nombra tiene que existir y ser de la
// org: un enlace a nada se quedaría ahí mintiendo.
//
// Roturas que atrapa: resolver un servidor sin mirar su org; no comprobar la
// org de la tarea de origen; aceptar un commit que no es un sha.
func TestWhatAnIncidentNamesMustBeOfItsOrganization(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	_, err := svc.Record("org-1", domain.DocOwnerList, "l-back", "u-1", "", domain.IncidentRequest{
		Title: "x", Servers: []string{"boaty"},
	})
	var noServer *ErrNoSuchServer
	if !errors.As(err, &noServer) {
		t.Fatalf("un servidor de otra org entra: %v", err)
	}
	if !strings.Contains(noServer.Error(), "gstd") || !strings.Contains(noServer.Error(), "pixel-vps") {
		t.Errorf("el error no dice qué servidores hay: %v", noServer)
	}
	if strings.Contains(noServer.Error(), "boaty, ") || strings.Count(noServer.Error(), "boaty") > 1 {
		t.Errorf("el error enseña servidores de otra org: %v", noServer)
	}
	_, err = svc.Record("org-1", domain.DocOwnerList, "l-back", "u-1", "", domain.IncidentRequest{
		Title: "x", OriginTaskID: "task-ajena",
	})
	if !errors.Is(err, ErrIncidentOriginNotHere) {
		t.Errorf("una tarea de otra org como origen entra: %v", err)
	}
	_, err = svc.Record("org-1", domain.DocOwnerList, "l-back", "u-1", "", domain.IncidentRequest{
		Title: "x", Commits: []string{"main"},
	})
	var bad *ErrBadCommit
	if !errors.As(err, &bad) {
		t.Errorf("«main» entra como commit: %v", err)
	}
	var n int64
	db.Model(&domain.Incident{}).Count(&n)
	if n != 0 {
		t.Errorf("se escribieron %d incidentes rechazados", n)
	}
}

// Un commit que cac ya vio sale con su título y su enlace aunque se nombre
// corto; añadir lo mismo dos veces no lo repite; un área añadida después
// también se encuentra.
//
// Roturas que atrapa: no completar el commit desde task_git_links; perder el
// `DoNothing` del conflicto (el segundo commit igual fallaría); no refrescar
// las palabras clave al añadir.
//
// Mutante equivalente, anotado: quitar el `seen` que descarta un commit
// repetido dentro de la misma petición no cambia nada observable, porque el
// `DoNothing` de la base descarta el segundo igual.
func TestAdditionsOnlyAddAndKeepItFindable(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	in := record(t, svc, "l-back", domain.IncidentRequest{
		Title: "cert-manager viejo", Servers: []string{"gstd"}, OriginTaskID: "task-283",
	})
	if in.OriginRef != "cc-283" {
		t.Errorf("la tarea de origen no sale por su ref: %q", in.OriginRef)
	}
	for i := 0; i < 2; i++ {
		got, err := svc.Add("org-1", in.ID, domain.IncidentAdditions{
			Commits: []string{"5397e32"}, Guards: []string{"cert_manager_can_clean_its_cloudflare_challenge"},
			Areas: []string{"helm"},
		})
		if err != nil {
			t.Fatalf("añadir (vez %d): %v", i+1, err)
		}
		in = got
	}
	if len(in.Commits) != 1 || in.Commits[0].SHA != "5397e32c0e5262dcb3cfeb0ca973f2c790a8e054" ||
		in.Commits[0].Title == "" || in.Commits[0].Repo != "RomanshkVolkov/c-c" {
		t.Errorf("el commit no se completó o se repitió: %+v", in.Commits)
	}
	if len(in.Guards) != 1 {
		t.Errorf("el guardián se repitió: %v", in.Guards)
	}
	hits, _ := repository.NewSearchRepository(db).Docs("helm", "org-1", 8)
	if !slices.Contains(hitIDs(hits, domain.SearchIncident), in.ID) {
		t.Error("el área añadida después no se encuentra")
	}
	if _, err := svc.Add("org-1", in.ID, domain.IncidentAdditions{}); !errors.Is(err, ErrIncidentNothingToAdd) {
		t.Errorf("añadir nada: %v", err)
	}

	fixed, err := svc.SetStatus(in.ID, domain.IncidentFixed)
	if err != nil || fixed.Status != domain.IncidentFixed || fixed.FixedAt == nil {
		t.Fatalf("cerrar: %+v %v", fixed, err)
	}
	reopened, _ := svc.SetStatus(in.ID, domain.IncidentOpen)
	if reopened.FixedAt != nil {
		t.Error("al reabrir se queda la fecha de arreglado")
	}
}

// Un incidente mal escrito se sustituye, no se edita: el viejo deja de salir
// en la lista y en la búsqueda, y no se puede sustituir dos veces.
//
// Roturas que atrapa: quitar el `NOT EXISTS` de la lista o de la búsqueda;
// dejar sustituir uno ya sustituido o uno de otra org.
func TestASupersededIncidentLeavesTheListAndTheSearch(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	old := record(t, svc, "l-back", domain.IncidentRequest{Title: "ufw corta la red", Servers: []string{"gstd"}})
	nu := record(t, svc, "l-back", domain.IncidentRequest{
		Title: "ufw corta la red del clúster", Servers: []string{"gstd"}, Supersedes: old.ID,
	})
	list, _, err := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}, Server: "gstd"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != nu.ID {
		t.Errorf("la lista no enseña sólo el vigente: %+v", list)
	}
	hits, _ := repository.NewSearchRepository(db).Docs("ufw", "org-1", 8)
	if ids := hitIDs(hits, domain.SearchIncident); slices.Contains(ids, old.ID) || !slices.Contains(ids, nu.ID) {
		t.Errorf("la búsqueda no enseña sólo el vigente: %v", ids)
	}
	if got, _ := svc.Get(old.ID); got.SupersededByID != nu.ID {
		t.Errorf("el viejo no dice quién lo sustituyó: %q", got.SupersededByID)
	}
	_, err = svc.Record("org-1", domain.DocOwnerList, "l-back", "u-1", "", domain.IncidentRequest{Title: "otra", Supersedes: old.ID})
	if !errors.Is(err, ErrIncidentAlreadySuperseded) {
		t.Errorf("se sustituye dos veces: %v", err)
	}
	_, err = svc.Record("org-2", domain.DocOwnerList, "l-otro", "u-1", "", domain.IncidentRequest{Title: "otra", Supersedes: nu.ID})
	if !errors.Is(err, ErrIncidentSupersedesNotHere) {
		t.Errorf("se sustituye uno de otra org: %v", err)
	}
}

// La lista por servidor, área, estado y espacio, con lo abierto primero: es lo
// que ve quien va a tocar un servidor.
//
// Roturas que atrapa: ordenar sólo por fecha (el abierto viejo queda debajo);
// filtrar el área sin normalizar; que el filtro de espacio deje pasar otro.
func TestTheListPutsWhatIsStillOpenFirst(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	// El abierto, en medio por fecha: así ni «lo más nuevo primero» ni «lo
	// más viejo primero» lo dejan arriba por casualidad.
	older := record(t, svc, "l-app", domain.IncidentRequest{Title: "el reto no se limpia", Status: "fixed", Areas: []string{"cert-manager"}})
	time.Sleep(10 * time.Millisecond)
	open := record(t, svc, "l-back", domain.IncidentRequest{Title: "pixel-vps corre cert-manager 1.14", Servers: []string{"pixel-vps"}, Areas: []string{"cert-manager"}})
	time.Sleep(10 * time.Millisecond)
	fixed := record(t, svc, "l-app", domain.IncidentRequest{Title: "1.14 no limpia el reto", Status: "fixed", Servers: []string{"gstd"}, Areas: []string{"cert-manager"}})

	list, _, _ := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}, Area: "Cert_Manager"})
	if len(list) != 3 || list[0].ID != open.ID || list[1].ID != fixed.ID || list[2].ID != older.ID {
		t.Fatalf("no van los abiertos primero y luego lo más nuevo: %+v", list)
	}
	if list[1].FixedAt == nil {
		t.Error("uno guardado como arreglado no tiene fecha")
	}
	if l, _, _ := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}, Status: "open"}); len(l) != 1 || l[0].ID != open.ID {
		t.Errorf("por estado: %+v", l)
	}
	if l, _, _ := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}, Server: "srv-gstd"}); len(l) != 1 || l[0].ID != fixed.ID {
		t.Errorf("por servidor (id): %+v", l)
	}
	if l, _, _ := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}, Node: "l-back"}); len(l) != 1 || l[0].ID != open.ID {
		t.Errorf("por nodo: %+v", l)
	}
	if l, _, _ := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}, SpaceID: "sp-2"}); len(l) != 0 {
		t.Errorf("el filtro de espacio deja pasar otro: %+v", l)
	}
	if l, _, _ := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-2"}}); len(l) != 0 {
		t.Errorf("otra org ve los incidentes: %+v", l)
	}
}

// El mapa enseña lo que mordió en cada nodo, sin cuerpo, y avisa si recortó.
//
// Roturas que atrapa: no pegar los incidentes al nodo; no recortar a
// ContextMaxIncidents; no decirlo en `truncated`.
func TestTheMapShowsWhatBitOnEachNode(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	for i := 0; i < domain.ContextMaxIncidents+1; i++ {
		record(t, svc, "l-back", domain.IncidentRequest{Title: fmt.Sprintf("tropiezo %d", i), Servers: []string{"gstd"}})
	}
	m, err := NewContextService(db).MapWith("org-1", "sp-1", nil, domain.ContextOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var back *domain.ContextNode
	for i := range m.Nodes {
		if m.Nodes[i].ID == "l-back" {
			back = &m.Nodes[i]
		}
	}
	if back == nil || back.Doc == nil || len(back.Doc.Incidents) != domain.ContextMaxIncidents {
		t.Fatalf("el nodo no lleva sus incidentes recortados: %+v", back)
	}
	if back.Doc.Incidents[0].Servers[0].Name != "gstd" {
		t.Errorf("el incidente del mapa no dice su servidor: %+v", back.Doc.Incidents[0])
	}
	if !slices.Contains(m.Truncated, "incidents") {
		t.Errorf("no dice que recortó: %v", m.Truncated)
	}
}

// El hook `cac-edit` casa el fichero que se edita con las pruebas que guardan
// cada incidente, y lo hace con el listado, sin pedir cada uno: los guardianes
// tienen que viajar en el listado y en el mapa (command-and-control-296).
//
// Roturas que atrapa: no rellenar `Guards` en `List` o en `ForDocs`, o
// devolver `null` donde no hay ninguno.
func TestTheListAndTheMapCarryTheGuards(t *testing.T) {
	db := incidentDB(t)
	svc := incidentSvc(db)
	con := record(t, svc, "l-back", domain.IncidentRequest{Title: "con guardián",
		Guards: []string{"ansible::tests::cert_manager_can_clean_its_cloudflare_challenge"}})
	sin := record(t, svc, "l-back", domain.IncidentRequest{Title: "sin guardián"})

	list, _, err := svc.List(domain.IncidentFilter{OrgIDs: []string{"org-1"}})
	if err != nil {
		t.Fatal(err)
	}
	byDoc, err := repository.NewIncidentRepository(db).ForDocs("org-1", []string{con.DocID})
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string][]domain.IncidentSummary{"el listado": list, "el mapa": byDoc[con.DocID]} {
		guards := map[string][]string{}
		for _, i := range got {
			guards[i.ID] = i.Guards
		}
		if g := guards[con.ID]; len(g) != 1 || g[0] != "ansible::tests::cert_manager_can_clean_its_cloudflare_challenge" {
			t.Errorf("%s no trae el guardián: %v", name, g)
		}
		if g := guards[sin.ID]; g == nil || len(g) != 0 {
			t.Errorf("%s: uno sin guardianes tiene que traer [] y trae %#v", name, g)
		}
	}
}
