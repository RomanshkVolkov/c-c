package repository

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// searchFTSDB: tareas, comentarios y notas con la búsqueda de texto completo
// montada como al arrancar.
func searchFTSDB(t *testing.T) *gorm.DB {
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
	const name = "cac_test_search_fts"
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
	if err := db.AutoMigrate(&domain.TaskList{}, &domain.Item{}, &domain.ItemComment{}, &domain.Note{}); err != nil {
		t.Fatal(err)
	}
	if err := EnsureSearchIndexes(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO task_lists (id, space_id, name, created_at, updated_at) VALUES ('l','s','Lista',now(),now())`).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func ftsTask(t *testing.T, db *gorm.DB, id, org, title, desc string) {
	t.Helper()
	it := &domain.Item{OrgID: org, ListID: "l", Title: title, Description: desc, Status: domain.ReportPending}
	it.ID = id
	if err := db.Create(it).Error; err != nil {
		t.Fatal(err)
	}
}

func ftsComment(t *testing.T, db *gorm.DB, id, item, body string) {
	t.Helper()
	c := &domain.ItemComment{ItemID: item, Body: body}
	c.ID = id
	if err := db.Create(c).Error; err != nil {
		t.Fatal(err)
	}
}

func hitIDs(hs []domain.SearchHit) []string {
	out := []string{}
	for _, h := range hs {
		out = append(out, h.ID)
	}
	return out
}

// Buscar tareas con texto completo: por el principio de la palabra, sin
// acentos, lo que casa en el título primero, y con el trozo de la descripción
// donde aparece. De un comentario no sale fragmento: puede ser interno.
func TestTaskSearchIsFullText(t *testing.T) {
	db := searchFTSDB(t)
	ftsTask(t, db, "titulo", "org-1", "Despliegue de koa", "")
	// Con acento en la descripción: la columna de las tareas tiene que ir sin
	// acentos, no sólo la de los comentarios.
	ftsTask(t, db, "descripcion", "org-1", "Mantenimiento", "Antes del lunes hay que parar el despliegué nocturno.")
	// La palabra muchas veces en la descripción puntúa más que una vez en el
	// título; aun así, la que se llama así va primero.
	ftsTask(t, db, "repetida", "org-1", "Notas", "despliegue despliegue despliegue despliegue despliegue despliegue")
	// Una descripción que no tiene que ver: el acierto está en el hilo, y del
	// hilo no sale fragmento.
	ftsTask(t, db, "comentario", "org-1", "Cosas del lunes", "Revisar los permisos del bucket.")
	ftsComment(t, db, "c1", "comentario", "El DESPLIEGUÉ se hizo a mano, ojo.")
	ftsTask(t, db, "borrado", "org-1", "Otra cosa", "")
	ftsComment(t, db, "c2", "borrado", "despliegue que se retiró")
	if err := db.Delete(&domain.ItemComment{}, "id = ?", "c2").Error; err != nil {
		t.Fatal(err)
	}
	ftsTask(t, db, "archivada", "org-1", "Despliegue viejo", "")
	if err := db.Model(&domain.Item{}).Where("id = ?", "archivada").Update("archived_at", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	ftsTask(t, db, "ajena", "org-2", "Despliegue de otra org", "")

	s := NewSearchRepository(db)
	hits, err := s.Tasks("desplieg", "org-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	got := hitIDs(hits)
	if len(got) != 4 || got[0] != "titulo" {
		t.Fatalf("por prefijo y sin acentos, con el título primero: %v", got)
	}
	for _, h := range hits {
		switch h.ID {
		case "descripcion":
			if !strings.Contains(h.Snippet, "**despliegué**") {
				t.Fatalf("el fragmento de la descripción no marca lo buscado: %q", h.Snippet)
			}
		case "comentario":
			if h.Snippet != "" {
				t.Fatalf("un comentario no puede salir como fragmento: %q", h.Snippet)
			}
		}
	}
	// Con un tope de uno, el que sobrevive es el del título: el orden cuenta
	// también al recortar, no sólo al pintar.
	if hits, _ := s.Tasks("desplieg", "org-1", 1); len(hits) != 1 || hits[0].ID != "titulo" {
		t.Fatalf("con tope 1: %v", hitIDs(hits))
	}
	// Sin acentos en la consulta tampoco.
	if hits, _ := s.Tasks("despliegué", "org-1", 10); len(hits) != 4 {
		t.Fatalf("con acento en la consulta: %v", hitIDs(hits))
	}
}

// Las notas, igual, y siempre de quien busca.
func TestNoteSearchIsFullText(t *testing.T) {
	db := searchFTSDB(t)
	for _, n := range []struct{ id, owner, title, body string }{
		{"mia-titulo", "u1", "Configuración del VPN", ""},
		{"mia-cuerpo", "u1", "Apuntes", "Para la configuracion hay que pedir acceso."},
		{"ajena", "u2", "Configuración", ""},
	} {
		x := &domain.Note{OwnerID: n.owner, Title: n.title, Body: n.body}
		x.ID = n.id
		if err := db.Create(x).Error; err != nil {
			t.Fatal(err)
		}
	}
	hits, err := NewSearchRepository(db).Notes("configur", "u1", 10)
	if err != nil {
		t.Fatal(err)
	}
	got := hitIDs(hits)
	if len(got) != 2 || got[0] != "mia-titulo" {
		t.Fatalf("notas: %v", got)
	}
	if !strings.Contains(hits[1].Snippet, "**configuracion**") {
		t.Fatalf("fragmento de la nota: %q", hits[1].Snippet)
	}
}
