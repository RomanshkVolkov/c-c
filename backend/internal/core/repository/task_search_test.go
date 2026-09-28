package repository

import (
	"fmt"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Buscar tareas mira el título, la descripción y los comentarios (#89).
//
// Sólo el título se quedaba corto para lo que más se busca —un comando, un
// error, un host—, que vive en la descripción o en el hilo. Un comentario
// borrado no cuenta, y lo que casa en el título sale primero.
func TestTaskSearchLooksPastTheTitle(t *testing.T) {
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
	const name = "cac_test_task_search"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}()
	if err := db.AutoMigrate(&domain.TaskList{}, &domain.Item{}, &domain.ItemComment{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO task_lists (id, space_id, name, created_at, updated_at) VALUES ('l','s','Lista',now(),now())`).Error; err != nil {
		t.Fatal(err)
	}
	for _, x := range []struct{ id, title, desc string }{
		{"en-titulo", "Rotar el certificado de koa", ""},
		{"en-descripcion", "Mantenimiento", "Hay que parar koa antes del lunes"},
		{"en-comentario", "Cosas del lunes", ""},
		{"en-comentario-borrado", "Otra cosa", ""},
		{"nada", "No tiene que ver", "de nada"},
	} {
		it := &domain.Item{OrgID: "org-1", ListID: "l", Title: x.title, Description: x.desc, Status: domain.ReportPending}
		it.ID = x.id
		if err := db.Create(it).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct{ id, item, body string }{
		{"c1", "en-comentario", "ojo: KOA reinicia a las 3"},
		{"c2", "en-comentario-borrado", "koa, pero esto se retiró"},
	} {
		cm := &domain.ItemComment{ItemID: c.item, Body: c.body}
		cm.ID = c.id
		if err := db.Create(cm).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Delete(&domain.ItemComment{}, "id = ?", "c2").Error; err != nil {
		t.Fatal(err)
	}

	hits, err := NewSearchRepository(db).Tasks("koa", "org-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.ID] = true
	}
	for _, id := range []string{"en-titulo", "en-descripcion", "en-comentario"} {
		if !got[id] {
			t.Errorf("tenía que encontrar %s (salieron %v)", id, got)
		}
	}
	if got["en-comentario-borrado"] {
		t.Error("un comentario borrado no puede hacer aparecer su tarea")
	}
	if got["nada"] {
		t.Error("una tarea sin «koa» no tiene que salir")
	}
	if len(hits) == 0 || hits[0].ID != "en-titulo" {
		t.Errorf("lo que casa en el título va primero, y el primero es %v", hits)
	}
}
