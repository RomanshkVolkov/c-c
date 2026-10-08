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

// pagesSQLDB: una base desechable con documentos, páginas y la búsqueda de
// texto completo montada como al arrancar (`EnsureSearchIndexes`).
func pagesSQLDB(t *testing.T) *gorm.DB {
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
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_doc_pages"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
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
		&domain.DocPage{}, &domain.DocPageVersion{},
	); err != nil {
		t.Fatal(err)
	}
	if err := EnsureSearchIndexes(db); err != nil {
		t.Fatal(err)
	}
	return db
}

type pagesFixture struct {
	db   *gorm.DB
	r    *DocRepository
	list *domain.TaskList
}

func newPagesFixture(t *testing.T, org string) pagesFixture {
	t.Helper()
	db := pagesSQLDB(t)
	sp := &domain.TaskSpace{OrgID: org, Name: "Proteus"}
	if err := db.Create(sp).Error; err != nil {
		t.Fatal(err)
	}
	l := &domain.TaskList{SpaceID: sp.ID, Name: "Apps"}
	if err := db.Create(l).Error; err != nil {
		t.Fatal(err)
	}
	return pagesFixture{db: db, r: NewDocRepository(db), list: l}
}

func (f pagesFixture) page(t *testing.T, org, title, body string, parent *string) *domain.DocPage {
	t.Helper()
	p, err := f.r.CreatePage(org, domain.DocOwnerList, f.list.ID,
		domain.CreateDocPageRequest{Title: title, Body: body, ParentID: parent}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// Una página no se puede mover bajo una hija suya, y lo dice la base.
//
// El mutante que mata: quitar la CTE de ancestros en `MovePage`. El árbol
// quedaría con un bucle y las páginas desaparecerían del navegador.
func TestMovingAPageUnderItsDescendantIsRefused(t *testing.T) {
	f := newPagesFixture(t, "o1")
	a := f.page(t, "o1", "Proteus", "", nil)
	b := f.page(t, "o1", "Vistas", "", &a.ID)
	c := f.page(t, "o1", "Detalle", "", &b.ID)

	err := f.r.MovePage(a.DocID, a.ID, domain.MoveDocPageRequest{ParentID: &c.ID})
	if err != ErrDocPageCycle {
		t.Fatalf("mover una página bajo su nieta: %v", err)
	}
	// Y un movimiento legal sí pasa, y deja el orden pedido.
	d := f.page(t, "o1", "Nereus", "", nil)
	if err := f.r.MovePage(a.DocID, d.ID, domain.MoveDocPageRequest{BeforeID: &a.ID}); err != nil {
		t.Fatal(err)
	}
	tree, _ := f.r.PageTree(a.DocID, false)
	var roots []string
	for _, x := range tree {
		if x.ParentID == nil {
			roots = append(roots, x.Title)
		}
	}
	if strings.Join(roots, ",") != "Nereus,Proteus" {
		t.Fatalf("el orden de la raíz quedó %v", roots)
	}
}

// La papelera se lleva el subárbol, y restaurar trae sólo lo que se fue junto.
//
// Los mutantes que mata: no marcar las descendientes (quedarían colgando de
// una página que no se ve) y restaurar todas las descendientes (volvería una
// hija que alguien borró antes, por su cuenta).
func TestTrashingAndRestoringMoveTheSubtreeTogether(t *testing.T) {
	f := newPagesFixture(t, "o1")
	a := f.page(t, "o1", "Triton", "", nil)
	b := f.page(t, "o1", "Roles", "", &a.ID)
	c := f.page(t, "o1", "Viejo", "", &a.ID)

	if _, err := f.r.TrashPage(a.DocID, c.ID); err != nil {
		t.Fatal(err)
	}
	n, err := f.r.TrashPage(a.DocID, a.ID)
	if err != nil || n != 2 {
		t.Fatalf("la papelera se llevó %d páginas: %v", n, err)
	}
	if _, err := f.r.FindPage(a.DocID, b.ID); err != ErrDocPageNotFound {
		t.Fatalf("una hija de una página borrada sigue viva: %v", err)
	}
	if err := f.r.RestorePage(a.DocID, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.r.FindPage(a.DocID, b.ID); err != nil {
		t.Fatalf("la hija que se fue con ella no volvió: %v", err)
	}
	if _, err := f.r.FindPage(a.DocID, c.ID); err != ErrDocPageNotFound {
		t.Fatal("volvió una hija que se había borrado antes, por su cuenta")
	}
}

// La búsqueda: por prefijo, sin acentos, el título pesa más, con fragmento y
// ruta, y sin páginas de la papelera ni de otra organización.
func TestDocSearchFindsPagesByPrefixWithSnippetAndPath(t *testing.T) {
	f := newPagesFixture(t, "o1")
	apps := f.page(t, "o1", "Apps", "", nil)
	f.page(t, "o1", "Nereus", "El back office. Corre los jobs de pocna-jobs cada noche.", &apps.ID)
	f.page(t, "o1", "Triton", "Procedimientos del muelle. Nereus le manda las órdenes.", &apps.ID)
	f.page(t, "o1", "Configuración", "La configuración del muelle.", nil)
	borrada := f.page(t, "o1", "Borrada", "Nereus otra vez.", nil)
	if _, err := f.r.TrashPage(borrada.DocID, borrada.ID); err != nil {
		t.Fatal(err)
	}
	s := NewSearchRepository(f.db)

	hits, err := s.Docs("nereus", "o1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("aciertos: %+v", hits)
	}
	// El que se llama así va primero.
	if hits[0].Title != "Nereus" {
		t.Fatalf("el título no pesa más que el cuerpo: %q primero", hits[0].Title)
	}
	if hits[0].Where != "Apps › Apps" || !strings.Contains(hits[0].Link, "&page="+hits[0].PageID) {
		t.Fatalf("ruta o enlace: %q %q", hits[0].Where, hits[0].Link)
	}
	if !strings.Contains(hits[1].Snippet, "**Nereus**") {
		t.Fatalf("el fragmento no marca la coincidencia: %q", hits[1].Snippet)
	}

	// Por prefijo.
	if hits, _ := s.Docs("pocna", "o1", 10); len(hits) != 1 {
		t.Fatalf("«pocna» no encuentra pocna-jobs: %+v", hits)
	}
	// Sin acentos, si la base tiene unaccent.
	var conUnaccent int64
	f.db.Raw(`SELECT count(*) FROM pg_extension WHERE extname = 'unaccent'`).Scan(&conUnaccent)
	if conUnaccent == 0 {
		t.Log("AVISO: sin la extensión unaccent; no se comprueba la búsqueda sin acentos")
	} else if hits, _ := s.Docs("configuracion", "o1", 10); len(hits) != 1 {
		t.Fatalf("«configuracion» no encuentra «Configuración»: %+v", hits)
	}
	// De otra organización, nada.
	if hits, _ := s.Docs("nereus", "o2", 10); len(hits) != 0 {
		t.Fatalf("la búsqueda cruza organizaciones: %+v", hits)
	}
}

// Un adjunto que sólo cita una página no se poda al guardar una pestaña, ni
// aunque la página esté en la papelera.
//
// El mutante que mata: que `AttachmentCited` mire sólo las pestañas, o sólo las
// páginas vivas. Restaurar la página encontraría una imagen rota.
func TestAnAttachmentCitedOnlyFromAPageIsStillCited(t *testing.T) {
	f := newPagesFixture(t, "o1")
	p := f.page(t, "o1", "Diagramas", "![d](/api/v1/docs/x/attachments/att-1/raw)", nil)
	if ok, err := f.r.AttachmentCited(p.DocID, "att-1"); err != nil || !ok {
		t.Fatalf("la página cita el adjunto y no cuenta: %v %v", ok, err)
	}
	if _, err := f.r.TrashPage(p.DocID, p.ID); err != nil {
		t.Fatal(err)
	}
	if ok, _ := f.r.AttachmentCited(p.DocID, "att-1"); !ok {
		t.Fatal("una página en la papelera deja de citar su adjunto")
	}
	if ok, _ := f.r.AttachmentCited(p.DocID, "att-2"); ok {
		t.Fatal("un adjunto que nadie cita cuenta como citado")
	}
}

// El índice cuenta las páginas, y un doc con sólo páginas sale como escrito.
func TestHasDocCountsPages(t *testing.T) {
	f := newPagesFixture(t, "o1")
	f.page(t, "o1", "Uno", "x", nil)
	f.page(t, "o1", "Dos", "", nil)
	marks, err := f.r.HasDoc("o1")
	if err != nil {
		t.Fatal(err)
	}
	m := marks["list:"+f.list.ID]
	if m.Pages != 2 || !m.Written {
		t.Fatalf("marca del doc: %+v", m)
	}
}

// Añadir al final de una página vacía no deja dos saltos delante, y el hash
// corresponde a lo que quedó.
func TestAppendToAPageKeepsTheHashTrue(t *testing.T) {
	f := newPagesFixture(t, "o1")
	p := f.page(t, "o1", "Notas", "", nil)
	if err := f.r.AppendPage(p.ID, "uno", "u1"); err != nil {
		t.Fatal(err)
	}
	if err := f.r.AppendPage(p.ID, "dos", "u2"); err != nil {
		t.Fatal(err)
	}
	got, _ := f.r.FindPage(p.DocID, p.ID)
	if got.Body != "uno\n\ndos" || got.BodyHash != HashBody(got.Body) {
		t.Fatalf("cuerpo %q, hash %q", got.Body, got.BodyHash)
	}
}

// Montar la búsqueda dos veces no rompe nada: se llama en cada arranque.
func TestEnsureSearchIndexesIsIdempotent(t *testing.T) {
	db := pagesSQLDB(t)
	if err := EnsureSearchIndexes(db); err != nil {
		t.Fatalf("la segunda vez falla: %v", err)
	}
	var n int64
	db.Raw(`SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_doc_tabs_search','idx_doc_pages_search')`).Scan(&n)
	if n != 2 {
		t.Fatalf("hay %d índices de búsqueda", n)
	}
	// Y una página se puede seguir creando: el struct no nombra la columna
	// generada (si lo hiciera, GORM intentaría escribirla y esto fallaría).
	if err := db.Create(&domain.DocPage{DocID: "d", OrgID: "o", Title: "x", Rank: "0.5"}).Error; err != nil {
		t.Fatalf("crear una página con la columna generada: %v", err)
	}
}
