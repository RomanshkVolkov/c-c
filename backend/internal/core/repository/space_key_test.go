package repository

import (
	"errors"
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// La clave de un espacio contra Postgres (cac#203).

func spaceKeyDB(t *testing.T) *gorm.DB {
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
	const name = "cac_test_space_keys"
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
	if err := db.AutoMigrate(&domain.TaskSpace{}, &domain.SpaceKeyAlias{}, &domain.Item{}, &domain.ReportProject{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func mkSpace(t *testing.T, db *gorm.DB, id, org, name, kind string) {
	t.Helper()
	sp := &domain.TaskSpace{OrgID: org, Name: name, Kind: kind, Rank: "0.5"}
	sp.ID = id
	if err := db.Create(sp).Error; err != nil {
		t.Fatal(err)
	}
}

func keyOf(t *testing.T, db *gorm.DB, id string) string {
	t.Helper()
	var sp domain.TaskSpace
	if err := db.First(&sp, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return sp.Key
}

// Los espacios que ya existían reciben su clave una vez. Roturas que detecta:
// que dos espacios de la misma org se queden con la misma; que el más nuevo
// le quite la clave sin letra al más viejo; que otra org cuente como choque;
// que choque con el slug de un proyecto de cliente; que la sala general lleve
// clave; y que una segunda pasada cambie lo que ya estaba.
func TestExistingSpacesGetAKeyOnce(t *testing.T) {
	db := spaceKeyDB(t)
	p := &domain.ReportProject{OrgID: "org-1", Name: "Acme", Slug: "acme", IngestKeyHash: []byte("x")}
	p.ID = "proj-1"
	if err := db.Create(p).Error; err != nil {
		t.Fatal(err)
	}
	mkSpace(t, db, "a", "org-1", "Proteus", "")
	mkSpace(t, db, "b", "org-1", "proteus", "")
	mkSpace(t, db, "c", "org-2", "Proteus", "")
	mkSpace(t, db, "d", "org-1", "Acme", "")
	mkSpace(t, db, "g", "org-1", "General", domain.SpaceKindGeneral)
	backfillSpaceKeys(db)
	for id, want := range map[string]string{"a": "proteus", "b": "proteus-b", "c": "proteus", "d": "acme-b", "g": ""} {
		if got := keyOf(t, db, id); got != want {
			t.Errorf("espacio %s: %q, quería %q", id, got, want)
		}
	}
	db.Model(&domain.TaskSpace{}).Where("id = ?", "a").Update("name", "Proteus PocNa")
	backfillSpaceKeys(db)
	if got := keyOf(t, db, "a"); got != "proteus" {
		t.Errorf("una segunda pasada o un renombrado cambió la clave: %q", got)
	}
	// Y la base no deja dos iguales en la misma org.
	if err := db.Model(&domain.TaskSpace{}).Where("id = ?", "b").Update("key", "proteus").Error; err == nil {
		t.Error("la base aceptó dos espacios con la misma clave en una org")
	}
}

// Roturas que detecta: que un espacio nuevo nazca sin clave, o con una que ya
// está tomada, o que la sala general nazca con una.
func TestANewSpaceIsBornWithItsKey(t *testing.T) {
	db := spaceKeyDB(t)
	r := NewTaskRepository(db)
	for _, id := range []string{"n1", "n2"} {
		sp := &domain.TaskSpace{OrgID: "org-1", Name: "Dwit México"}
		sp.ID = id
		if err := r.CreateSpace(sp); err != nil {
			t.Fatal(err)
		}
	}
	if keyOf(t, db, "n1") != "dwit-mexico" || keyOf(t, db, "n2") != "dwit-mexico-b" {
		t.Errorf("claves: %q %q", keyOf(t, db, "n1"), keyOf(t, db, "n2"))
	}
	// La sala general no tiene tareas que nombrar: sin clave.
	gen := &domain.TaskSpace{OrgID: "org-1", Name: "General", Kind: domain.SpaceKindGeneral}
	gen.ID = "gen"
	if err := r.CreateSpace(gen); err != nil {
		t.Fatal(err)
	}
	if got := keyOf(t, db, "gen"); got != "" {
		t.Errorf("la sala general nació con clave %q", got)
	}
}

// Roturas que detecta: aceptar una clave mal formada o tomada; perder la
// vieja (lo que la citaba dejaría de enlazar); y que volver a una clave
// antigua la deje también como alias.
func TestChangingAKeyKeepsTheOldOne(t *testing.T) {
	db := spaceKeyDB(t)
	r := NewTaskRepository(db)
	mkSpace(t, db, "a", "org-1", "Proteus", "")
	mkSpace(t, db, "b", "org-1", "Otro", "")
	backfillSpaceKeys(db)
	if err := r.ChangeSpaceKey("a", "Pocna"); !errors.Is(err, ErrSpaceKeyInvalid) {
		t.Errorf("mal formada: %v", err)
	}
	if err := r.ChangeSpaceKey("a", "otro"); !errors.Is(err, ErrSpaceKeyTaken) {
		t.Errorf("tomada: %v", err)
	}
	if err := r.ChangeSpaceKey("a", "pocna"); err != nil {
		t.Fatal(err)
	}
	if sp, err := findSpaceByKey(db, "org-1", "proteus"); err != nil || sp.ID != "a" {
		t.Errorf("la clave vieja ya no lleva a su espacio: %v", err)
	}
	if err := r.ChangeSpaceKey("b", "proteus"); !errors.Is(err, ErrSpaceKeyTaken) {
		t.Errorf("otro espacio se quedó la clave vieja de a: %v", err)
	}
	if err := r.ChangeSpaceKey("a", "proteus"); err != nil {
		t.Fatal(err)
	}
	var n int64
	db.Model(&domain.SpaceKeyAlias{}).Where("space_id = ? AND key = ?", "a", "proteus").Count(&n)
	if n != 0 || keyOf(t, db, "a") != "proteus" {
		t.Errorf("volver a la clave antigua: alias %d, clave %q", n, keyOf(t, db, "a"))
	}
}

// Una referencia `clave-N` encuentra la tarea interna N de ese espacio. Roturas
// que detecta: no buscar por clave; tomar una en mayúsculas (`PROTEUS-205` es
// de Jira); encontrar una tarea de cliente con el mismo número; mirar fuera
// de la org; no aceptar la clave vieja; y que la clave le gane a un folio.
func TestASpaceKeyRefFindsItsTask(t *testing.T) {
	db := spaceKeyDB(t)
	r := NewTaskRepository(db)
	g := NewGitHubRepository(db)
	mkSpace(t, db, "sp-proteus", "org-1", "Proteus", "")
	mkSpace(t, db, "sp-repo", "org-1", "Command and control", "")
	backfillSpaceKeys(db)
	p := &domain.ReportProject{OrgID: "org-1", Name: "Acme", Slug: "acme", IngestKeyHash: []byte("x")}
	p.ID = "proj-1"
	if err := db.Create(p).Error; err != nil {
		t.Fatal(err)
	}
	for _, it := range []domain.Item{
		{OrgID: "org-1", SpaceID: "sp-proteus", ListID: "l", Seq: 12, Title: "interna", Status: domain.ReportPending},
		{OrgID: "org-1", SpaceID: "sp-proteus", ListID: "l", Seq: 13, Title: "de cliente", Status: domain.ReportPending, ProjectID: "proj-1"},
		{OrgID: "org-1", SpaceID: "sp-repo", ListID: "l", Seq: 7, Title: "acme", Status: domain.ReportPending, ProjectID: "proj-1"},
	} {
		it := it
		it.ID = it.Title
		if err := db.Create(&it).Error; err != nil {
			t.Fatal(err)
		}
	}
	find := func(ref domain.TaskRef, org string) string {
		it, err := g.FindRefTarget(org, "sp-repo", ref)
		if err != nil {
			return ""
		}
		return it.ID
	}
	if got := find(domain.TaskRef{Slug: "proteus", Seq: 12}, "org-1"); got != "interna" {
		t.Errorf("proteus-12 desde el repo de otro espacio: %q", got)
	}
	if got := find(domain.TaskRef{Slug: "proteus", Seq: 12, Folded: true}, "org-1"); got != "" {
		t.Errorf("PROTEUS-12 (Jira) enlazó: %q", got)
	}
	if got := find(domain.TaskRef{Slug: "proteus", Seq: 13}, "org-1"); got != "" {
		t.Errorf("proteus-13 encontró la tarea de cliente: %q", got)
	}
	if got := find(domain.TaskRef{Slug: "proteus", Seq: 12}, "org-2"); got != "" {
		t.Errorf("cruzó de org: %q", got)
	}
	if got := find(domain.TaskRef{Slug: "acme", Seq: 7}, "org-1"); got != "acme" {
		t.Errorf("el folio de cliente: %q", got)
	}
	if err := r.ChangeSpaceKey("sp-proteus", "pocna"); err != nil {
		t.Fatal(err)
	}
	if got := find(domain.TaskRef{Slug: "proteus", Seq: 12}, "org-1"); got != "interna" {
		t.Errorf("la clave vieja dejó de enlazar: %q", got)
	}
	if got := find(domain.TaskRef{Slug: "pocna", Seq: 12}, "org-1"); got != "interna" {
		t.Errorf("la clave nueva: %q", got)
	}
}

// Rotura que detecta: crear un proyecto de cliente con el slug que ya es la
// clave de un espacio de la org (`acme-7` ya no diría de quién es).
func TestAProjectCannotTakeASpaceKey(t *testing.T) {
	db := spaceKeyDB(t)
	mkSpace(t, db, "a", "org-1", "Acme", "")
	backfillSpaceKeys(db)
	projects := NewReportProjectRepository(db)
	p := &domain.ReportProject{OrgID: "org-1", Name: "Acme", Slug: "acme", IngestKeyHash: []byte("x")}
	p.ID = "proj-1"
	if err := projects.Create(p); !errors.Is(err, ErrReportProjectSlugTaken) {
		t.Fatalf("un proyecto se quedó la clave de un espacio: %v", err)
	}
	other := &domain.ReportProject{OrgID: "org-2", Name: "Acme", Slug: "acme", IngestKeyHash: []byte("x")}
	other.ID = "proj-2"
	if err := projects.Create(other); err != nil {
		t.Fatalf("en otra org sí vale: %v", err)
	}
}
