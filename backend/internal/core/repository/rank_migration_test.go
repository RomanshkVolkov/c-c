package repository

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// La migración de rangos, ensayada contra datos como los que hay en producción.
//
// Es la única forma de saber si sirve: convierte claves de texto en base 62 a
// números, y lo que no puede pasar es que el orden que la gente ve hoy cambie
// al desplegar. Una tarjeta que se mueve sola de sitio no da ningún error.
func rankMigrationDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_rank_migration"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	// Colación `C` explícita, como producción. Sin esto la prueba diría cosas
	// distintas según la imagen de Postgres que haya debajo — que es justo el
	// fallo que trajo aquí: `postgres:16-alpine` (musl) ordena por bytes y
	// `postgres:16` (glibc) no, aunque las dos digan `en_US.utf8`.
	if err := admin.Exec("CREATE DATABASE " + name +
		" TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'").Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	// El esquema **viejo**, a mano: `rank` es texto. Pedírselo a `AutoMigrate`
	// lo crearía ya numérico y la prueba no ensayaría nada.
	for _, ddl := range []string{
		`CREATE TABLE task_spaces (id varchar(36) PRIMARY KEY, org_id varchar(36), rank varchar(64))`,
		`CREATE TABLE items (id varchar(36) PRIMARY KEY, list_id varchar(36), status varchar(20), rank varchar(64))`,
	} {
		if err := db.Exec(ddl).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db, func() {
		if sqlDB, e := db.DB(); e == nil {
			sqlDB.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if adminSQL != nil {
			adminSQL.Close()
		}
	}
}

func namesInRankOrder(t *testing.T, db *gorm.DB, table, where string) []string {
	t.Helper()
	var ids []string
	if err := db.Raw(fmt.Sprintf(
		"SELECT id FROM %s WHERE %s ORDER BY rank ASC", table, where)).Scan(&ids).Error; err != nil {
		t.Fatal(err)
	}
	return ids
}

// El caso que trajo todo esto: «U» y «k», las dos primeras claves que repartía
// un contenedor vacío. Con la colación de producción «U» va primero, y después
// de migrar tiene que seguir yendo primero.
func TestTheMigrationKeepsTheOrderPeopleSeeToday(t *testing.T) {
	db, cleanup := rankMigrationDB(t)
	defer cleanup()

	// Los ids van a contrapelo del orden de los rangos —zeta primero, alfa
	// último— para que una migración que ordenara por cualquier otra cosa se
	// notara. Con ids que ya estaban en orden, no se notaría.
	db.Exec(`INSERT INTO task_spaces (id, org_id, rank) VALUES
		('zeta', 'org-1', 'U'), ('mu', 'org-1', 'k'), ('alfa', 'org-1', 's')`)
	// Sus claves van **después** de todas las de org-1 a propósito: numeradas
	// todas juntas, org-2 empezaría por el cuarto número; numerada cada
	// organización por su lado, empieza por el primero, como org-1.
	db.Exec(`INSERT INTO task_spaces (id, org_id, rank) VALUES
		('otra-z', 'org-2', 'w'), ('otra-a', 'org-2', 'x')`)

	antes := namesInRankOrder(t, db, "task_spaces", "org_id = 'org-1'")
	migrateRanks(db)
	despues := namesInRankOrder(t, db, "task_spaces", "org_id = 'org-1'")

	if fmt.Sprint(antes) != fmt.Sprint(despues) {
		t.Fatalf("el orden cambió al migrar: %v → %v", antes, despues)
	}
	if fmt.Sprint(despues) != "[zeta mu alfa]" {
		t.Fatalf("orden = %v, quería [zeta mu alfa]", despues)
	}
	if orden := namesInRankOrder(t, db, "task_spaces", "org_id = 'org-2'"); fmt.Sprint(orden) != "[otra-z otra-a]" {
		t.Fatalf("la otra organización quedó %v", orden)
	}
	// Cada organización se numera por su lado. No cambia el orden que se ve
	// —numeradas juntas también saldría bien— pero sí cuánto sitio le queda a
	// cada una: sin partición, una organización grande empuja a las demás
	// hacia el final del hueco y las claves se alargan por lo que hizo otra.
	var deUna, deOtra string
	db.Raw(`SELECT rank::text FROM task_spaces WHERE id='zeta'`).Scan(&deUna)
	db.Raw(`SELECT rank::text FROM task_spaces WHERE id='otra-z'`).Scan(&deOtra)
	if deUna != deOtra {
		t.Fatalf("las dos organizaciones se numeraron juntas: %q vs %q", deUna, deOtra)
	}
}

// Más de nueve hermanos, que es donde se rompe si los números se reparten con
// menos dígitos de los que hacen falta: con uno solo, la décima fila sería
// «0.10» y quedaría **por debajo** de «0.9». Diez tarjetas en una columna no es
// un caso raro.
func TestMoreThanNineSiblingsStayInOrder(t *testing.T) {
	db, cleanup := rankMigrationDB(t)
	defer cleanup()

	// Claves viejas de una sola letra en orden ASCII: A, B, … L.
	for i := 0; i < 12; i++ {
		db.Exec(`INSERT INTO task_spaces (id, org_id, rank) VALUES (?, 'org-1', ?)`,
			fmt.Sprintf("s-%02d", i), string(rune('A'+i)))
	}
	antes := namesInRankOrder(t, db, "task_spaces", "org_id = 'org-1'")
	migrateRanks(db)
	despues := namesInRankOrder(t, db, "task_spaces", "org_id = 'org-1'")

	if fmt.Sprint(antes) != fmt.Sprint(despues) {
		t.Fatalf("con doce hermanos el orden cambió: %v → %v", antes, despues)
	}
}

// Un rango sólo se compara con sus hermanos. En el tablero los hermanos son los
// de la misma columna, así que el estado entra en la partición: si no, las
// tarjetas de «hecho» se numerarían entremezcladas con las de «abierto» y
// bastaría mover una para que la otra columna se recolocara.
func TestEachBoardColumnIsNumberedOnItsOwn(t *testing.T) {
	db, cleanup := rankMigrationDB(t)
	defer cleanup()

	db.Exec(`INSERT INTO items (id, list_id, status, rank) VALUES
		('abierta-1', 'li-1', 'open', 'U'), ('abierta-2', 'li-1', 'open', 'k'),
		('hecha-1',   'li-1', 'done', 'U'), ('hecha-2',   'li-1', 'done', 'k')`)

	migrateRanks(db)

	if o := namesInRankOrder(t, db, "items", "list_id='li-1' AND status='open'"); fmt.Sprint(o) != "[abierta-1 abierta-2]" {
		t.Fatalf("columna abierta = %v", o)
	}
	if o := namesInRankOrder(t, db, "items", "list_id='li-1' AND status='done'"); fmt.Sprint(o) != "[hecha-1 hecha-2]" {
		t.Fatalf("columna hecha = %v", o)
	}
	// Y las dos columnas arrancan en el mismo sitio, que es lo que prueba que
	// se numeraron por separado y no en una sola cuenta corrida.
	var abierta, hecha string
	db.Raw(`SELECT rank::text FROM items WHERE id='abierta-1'`).Scan(&abierta)
	db.Raw(`SELECT rank::text FROM items WHERE id='hecha-1'`).Scan(&hecha)
	if abierta != hecha {
		t.Fatalf("las columnas se numeraron juntas: %q vs %q", abierta, hecha)
	}
}

// Después de migrar, la columna es un número — y ahí se acaba la dependencia de
// la colación, que es el punto de todo esto.
func TestTheColumnEndsUpNumeric(t *testing.T) {
	db, cleanup := rankMigrationDB(t)
	defer cleanup()
	db.Exec(`INSERT INTO task_spaces (id, org_id, rank) VALUES ('a', 'org-1', 'U')`)

	migrateRanks(db)

	var kind string
	db.Raw(`SELECT data_type FROM information_schema.columns
	        WHERE table_name = 'task_spaces' AND column_name = 'rank'`).Scan(&kind)
	if kind != "numeric" {
		t.Fatalf("la columna quedó en %q", kind)
	}
}

// Arranca en cada despliegue, así que la segunda vez tiene que no hacer nada.
//
// Y «no hacer nada» quiere decir **no tocar los valores**: una migración que
// renumerase otra vez sería inofensiva de puro milagro, porque el orden se
// conservaría, pero convertiría cada arranque en una escritura sobre todas las
// filas de la base.
func TestRunningItTwiceChangesNothing(t *testing.T) {
	db, cleanup := rankMigrationDB(t)
	defer cleanup()
	db.Exec(`INSERT INTO task_spaces (id, org_id, rank) VALUES
		('a', 'org-1', 'U'), ('b', 'org-1', 'k')`)

	migrateRanks(db)

	// Y en medio, alguien arrastra una tarjeta: eso mete un valor fino entre
	// dos. Es lo que distingue «no hacer nada» de «volver a repartir»: repartir
	// otra vez daría los mismos números a las de siempre —el orden se
	// conservaría de milagro— pero **se comería el arrastre**, redondeando ese
	// valor fino al siguiente hueco entero.
	db.Exec(`INSERT INTO task_spaces (id, org_id, rank) VALUES ('arrastrada', 'org-1', '0.15')`)

	var primera []string
	db.Raw(`SELECT rank::text FROM task_spaces ORDER BY id`).Scan(&primera)

	migrateRanks(db)
	var segunda []string
	db.Raw(`SELECT rank::text FROM task_spaces ORDER BY id`).Scan(&segunda)

	if fmt.Sprint(primera) != fmt.Sprint(segunda) {
		t.Fatalf("la segunda pasada cambió los valores: %v → %v", primera, segunda)
	}
}

// Una base recién creada no tiene ninguna de estas tablas todavía: la migración
// corre antes que `AutoMigrate`. Tiene que no hacer nada, no reventar el
// arranque — es el caso de un primer despliegue y el de restaurar desde cero.
func TestAFreshDatabaseIsLeftAlone(t *testing.T) {
	db, cleanup := rankMigrationDB(t)
	defer cleanup()
	db.Exec(`DROP TABLE task_spaces`)
	db.Exec(`DROP TABLE items`)

	migrateRanks(db) // sin tablas, y sin pánico
}
