package repository

import (
	"fmt"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// La bandeja de un canal, contra una base de verdad (tarjeta #70).
//
// Cambiar desde Integraciones la lista donde caen los reportes de un cliente
// fallaba con **cualquier** lista: «esa lista es de otra organización». Eran dos
// fallos seguidos, y ninguno se podía ver sin Postgres:
//
//  1. La guarda preguntaba por `l.deleted_at`, una columna que `task_lists` no
//     tiene. La consulta reventaba siempre, el error no se miraba, y la
//     organización salía vacía — que nunca coincide con la del proyecto.
//  2. Y detrás, aunque la guarda pasara, `Update` no escribía `list_id`. La
//     respuesta enseñaba la lista nueva y la fila se quedaba con la vieja.
//
// Las pruebas que había de esto (`service/report_project_patch_test.go`) evitan
// la base a propósito, porque se escribieron cuando el CI no corría el backend.
// Comprueban el objeto en memoria, así que las dos cosas se les escapaban. El
// CI ya corre con Postgres (#38): éstas sí miran la fila.

func inboxTestDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_report_inbox"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	// Las tablas de verdad, migradas desde los structs: si `TaskList` algún día
	// gana borrado en blando, la columna aparece aquí sola, y esta prueba sigue
	// diciendo la verdad sobre el esquema que corre en producción.
	if err := db.AutoMigrate(&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{}, &domain.ReportProject{}); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	for _, q := range []string{
		`INSERT INTO task_spaces (id, org_id, name, created_at, updated_at) VALUES ('sp-a','org-a','A',?,?)`,
		`INSERT INTO task_spaces (id, org_id, name, created_at, updated_at) VALUES ('sp-b','org-b','B',?,?)`,
		`INSERT INTO task_folders (id, space_id, name, created_at, updated_at) VALUES ('fo-a','sp-a','Carpeta',?,?)`,
		`INSERT INTO task_lists (id, space_id, name, created_at, updated_at) VALUES ('li-a1','sp-a','Una',?,?)`,
		`INSERT INTO task_lists (id, space_id, name, created_at, updated_at) VALUES ('li-a2','sp-a','Otra',?,?)`,
		// En una carpeta, que es donde están casi todas las bandejas de verdad
		// (Portento → Dashboard, Boaty → web). Una lista en carpeta sigue
		// llevando su `space_id`; si dejara de llevarlo, esto lo dice.
		`INSERT INTO task_lists (id, space_id, folder_id, name, created_at, updated_at) VALUES ('li-af','sp-a','fo-a','En carpeta',?,?)`,
		`INSERT INTO task_lists (id, space_id, name, created_at, updated_at) VALUES ('li-b1','sp-b','De otra',?,?)`,
		`INSERT INTO report_projects (id, org_id, name, slug, ingest_key_hash, list_id, created_at, updated_at)
			VALUES ('pr-a','org-a','Cliente','cliente','\x00','li-a1',?,?)`,
	} {
		if err := db.Exec(q, ahora, ahora).Error; err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

// El fallo reportado: la guarda tiene que contestar la organización de la lista,
// y no «ninguna» porque su propia consulta esté rota.
//
// El mutante que mata: volver a pedir `l.deleted_at`. Con él la consulta falla,
// y como ahora el error vuelve, la prueba lo ve en vez de recibir un vacío.
func TestTheInboxGuardAsksTheListsOwnSpace(t *testing.T) {
	db, cleanup := inboxTestDB(t)
	defer cleanup()
	r := NewReportProjectRepository(db)

	for _, c := range []struct{ list, want string }{
		{"li-a1", "org-a"},
		{"li-af", "org-a"}, // en carpeta
		{"li-b1", "org-b"},
		{"no-existe", ""},
	} {
		got, err := r.ListOrgID(c.list)
		if err != nil {
			t.Fatalf("%s: la consulta falló: %v", c.list, err)
		}
		if got != c.want {
			t.Errorf("%s: la organización salió %q, y es %q", c.list, got, c.want)
		}
	}
}

// El fallo de detrás: mover la bandeja tiene que quedarse en la fila.
//
// Se relee de la base a propósito. Lo que devuelve `Update` es el objeto que se
// le pasó, y ése siempre dice lo que se le pidió — que es por lo que esto pasó
// sin que nada lo notara.
//
// El mutante que mata: quitar `list_id` del mapa de `Update`.
func TestChangingTheInboxIsSaved(t *testing.T) {
	db, cleanup := inboxTestDB(t)
	defer cleanup()
	r := NewReportProjectRepository(db)

	p, err := r.FindByID("pr-a")
	if err != nil {
		t.Fatal(err)
	}
	nueva := "li-a2"
	p.ListID = &nueva
	if err := r.Update(p); err != nil {
		t.Fatal(err)
	}

	releido, err := r.FindByID("pr-a")
	if err != nil {
		t.Fatal(err)
	}
	if releido.ListID == nil || *releido.ListID != "li-a2" {
		fila := "<nada>"
		if releido.ListID != nil {
			fila = *releido.ListID
		}
		t.Errorf("la bandeja no se guardó: la fila sigue diciendo %q", fila)
	}
}
