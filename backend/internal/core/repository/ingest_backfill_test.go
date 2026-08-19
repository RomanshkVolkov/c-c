package repository

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

/*
Darle hogar a los reportes que entraron sin él.

El ingest nunca copió `org_id` ni `list_id` del proyecto a la fila. La migración
a items se los puso una vez a los que ya existían, y desde entonces cada reporte
de cliente entraba huérfano: fuera de todo tablero, y con un detalle que
contestaba «list not found».

Este relleno repara filas de clientes en producción, así que lo que importa es
tanto que arregle lo roto como que **no toque lo que ya está bien**.
*/
func TestElRellenoDaHogarAlHuerfanoYNoTocaLoDemas(t *testing.T) {
	db, cleanup := backfillDB(t)
	defer cleanup()

	backfillIngestedItems(db)

	var huerfano, colocado, ajeno domain.Item
	if err := db.First(&huerfano, "id = 'sin-hogar'").Error; err != nil {
		t.Fatal(err)
	}
	if huerfano.ListID != "lista-1" || huerfano.OrgID != "org-1" {
		t.Errorf("el huérfano tenía que aterrizar; quedó en lista=%q org=%q",
			huerfano.ListID, huerfano.OrgID)
	}
	if huerfano.SpaceID != "esp-1" {
		t.Errorf("y con su espacio; quedó en %q", huerfano.SpaceID)
	}

	// El que ya estaba colocado no se mueve, aunque su lista no sea la bandeja
	// del canal: alguien lo puso ahí a mano y reasignarlo sería deshacerlo.
	if err := db.First(&colocado, "id = 'ya-colocado'").Error; err != nil {
		t.Fatal(err)
	}
	if colocado.ListID != "lista-2" {
		t.Errorf("no se reasigna lo colocado; se movió a %q", colocado.ListID)
	}

	// Y una tarea interna, sin canal, no es asunto de este relleno.
	if err := db.First(&ajeno, "id = 'interna'").Error; err != nil {
		t.Fatal(err)
	}
	if ajeno.ListID != "" {
		t.Errorf("una tarea sin canal no se toca; quedó en %q", ajeno.ListID)
	}
}

// Corre en cada arranque, así que la segunda vez no puede cambiar nada.
func TestElRellenoEsIdempotente(t *testing.T) {
	db, cleanup := backfillDB(t)
	defer cleanup()

	backfillIngestedItems(db)
	var primera domain.Item
	db.First(&primera, "id = 'sin-hogar'")

	backfillIngestedItems(db)
	var segunda domain.Item
	db.First(&segunda, "id = 'sin-hogar'")

	if primera.ListID != segunda.ListID || primera.OrgID != segunda.OrgID {
		t.Errorf("la segunda pasada cambió algo: %q/%q → %q/%q",
			primera.ListID, primera.OrgID, segunda.ListID, segunda.OrgID)
	}
}

// Un canal sin bandeja deja al reporte donde está, sin inventarle una lista.
func TestSinBandejaElHuerfanoSeQuedaSinLista(t *testing.T) {
	db, cleanup := backfillDB(t)
	defer cleanup()
	if err := db.Exec(`UPDATE report_projects SET list_id = NULL WHERE id = 'proj-1'`).Error; err != nil {
		t.Fatal(err)
	}

	backfillIngestedItems(db)

	var huerfano domain.Item
	db.First(&huerfano, "id = 'sin-hogar'")
	if huerfano.ListID != "" {
		t.Errorf("no hay bandeja que copiar; se inventó %q", huerfano.ListID)
	}
	// La organización sí, que no depende de que haya tablero.
	if huerfano.OrgID != "org-1" {
		t.Errorf("la organización sale igual del proyecto; quedó %q", huerfano.OrgID)
	}
}

func backfillDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_backfill"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.TaskSpace{},
		&domain.TaskList{}, &domain.Item{}, &domain.ReportProject{}); err != nil {
		t.Fatal(err)
	}

	ahora := time.Now()
	must := func(tx *gorm.DB) {
		t.Helper()
		if tx.Error != nil {
			t.Fatalf("la fixture no se pudo insertar: %v", tx.Error)
		}
	}
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
		VALUES ('org-1','Uno','uno',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-1','org-1','Portento','#fff','m',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO task_lists (id, space_id, name, rank, created_at, updated_at)
		VALUES ('lista-1','esp-1','tasks','m',?,?), ('lista-2','esp-1','otra','n',?,?)`,
		ahora, ahora, ahora, ahora))
	must(db.Exec(`INSERT INTO report_projects (id, org_id, name, slug, ingest_key_hash, is_active, list_id, created_at, updated_at)
		VALUES ('proj-1','org-1','Portento','portento','\x00',true,'lista-1',?,?)`, ahora, ahora))

	// El huérfano: con canal y sin nada más. Es `portento-99`.
	must(db.Exec(`INSERT INTO items (id, project_id, seq, title, status, category, priority, origin, visibility, created_at, updated_at)
		VALUES ('sin-hogar','proj-1',99,'Meter buscador','pending','ui','normal','user','public',?,?)`, ahora, ahora))
	// Uno ya colocado, y a propósito en una lista que no es la bandeja.
	must(db.Exec(`INSERT INTO items (id, project_id, org_id, list_id, seq, title, status, category, priority, origin, visibility, created_at, updated_at)
		VALUES ('ya-colocado','proj-1','org-1','lista-2',98,'Movida a mano','pending','ui','normal','user','public',?,?)`, ahora, ahora))
	// Y una interna, que no tiene nada que ver con ningún canal.
	must(db.Exec(`INSERT INTO items (id, project_id, seq, title, status, category, priority, origin, visibility, created_at, updated_at)
		VALUES ('interna','',0,'Cosa nuestra','pending','other','normal','internal','internal',?,?)`, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
