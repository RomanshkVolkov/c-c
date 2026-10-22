package repository

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Una tarea se encuentra por como se nombra fuera (22-oct-2026): la clave de
// su espacio y su número (`proteus-12`) o el folio de un cliente (`acme-7`),
// y sólo en las organizaciones dadas: dos orgs pueden tener un espacio con la
// misma clave, y la tarea 12 de una no es la de la otra.
//
// Roturas que detecta: no mirar la org (la de otra sale); no resolver el
// folio; resolver una clave que venía en mayúsculas (`PROTEUS-12` es de
// Jira); o inventar algo para un número sin espacio (`cac#12`).
func TestATaskIsFoundByItsRefOnlyInTheGivenOrgs(t *testing.T) {
	db := refDB(t)
	r := NewTaskRepository(db)

	it, err := r.FindByRef([]string{"org-1"}, domain.TaskRef{Slug: "proteus", Seq: 12})
	if err != nil || it.ID != "it-1-12" {
		t.Fatalf("proteus-12 en org-1: %+v %v", it, err)
	}
	it, err = r.FindByRef([]string{"org-2"}, domain.TaskRef{Slug: "proteus", Seq: 12})
	if err != nil || it.ID != "it-2-12" {
		t.Fatalf("proteus-12 en org-2 es otra tarea: %+v %v", it, err)
	}
	it, err = r.FindByRef([]string{"org-1"}, domain.TaskRef{Slug: "acme", Seq: 7})
	if err != nil || it.ID != "it-acme-7" {
		t.Fatalf("el folio acme-7: %+v %v", it, err)
	}
	for _, c := range []struct {
		ref    domain.TaskRef
		orgs   []string
		porque string
	}{
		{domain.TaskRef{Slug: "proteus", Seq: 12}, []string{"org-3"}, "no es de esa org"},
		{domain.TaskRef{Slug: "proteus", Seq: 12, Folded: true}, []string{"org-1"}, "venía en mayúsculas: es la clave de Jira"},
		{domain.TaskRef{Seq: 12}, []string{"org-1"}, "un número sin espacio no dice de cuál"},
		{domain.TaskRef{Slug: "proteus", Seq: 99}, []string{"org-1"}, "no existe"},
	} {
		if it, err := r.FindByRef(c.orgs, c.ref); err == nil {
			t.Errorf("%+v %s, y se resolvió a %s", c.ref, c.porque, it.ID)
		}
	}
}

func refDB(t *testing.T) *gorm.DB {
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
	const name = "cac_test_task_by_ref"
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
	if err := db.AutoMigrate(&domain.TaskSpace{}, &domain.Item{}, &domain.ReportProject{}); err != nil {
		t.Fatal(err)
	}
	must := func(v any) {
		t.Helper()
		if err := db.Create(v).Error; err != nil {
			t.Fatalf("%T: %v", v, err)
		}
	}
	for _, sp := range []struct{ id, org string }{{"sp-1", "org-1"}, {"sp-2", "org-2"}} {
		s := &domain.TaskSpace{OrgID: sp.org, Name: "Proteus", Key: "proteus", Rank: "0.5"}
		s.ID = sp.id
		must(s)
	}
	p := &domain.ReportProject{OrgID: "org-1", Slug: "acme", Name: "Acme", IngestKeyHash: []byte("x")}
	p.ID = "proj-acme"
	must(p)
	for _, it := range []struct {
		id, org, space, project string
		seq                     int
	}{
		{"it-1-12", "org-1", "sp-1", "", 12},
		{"it-2-12", "org-2", "sp-2", "", 12},
		{"it-acme-7", "org-1", "sp-1", "proj-acme", 7},
	} {
		x := &domain.Item{OrgID: it.org, SpaceID: it.space, ListID: "l", ProjectID: it.project, Seq: it.seq, Title: it.id, Status: domain.ReportPending}
		x.ID = it.id
		must(x)
	}
	return db
}
