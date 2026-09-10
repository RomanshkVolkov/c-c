package repository

import (
	"fmt"

	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"gorm.io/gorm"
)

// El orden de un tablero deja de depender de cómo se configuró la base.
//
// Hasta el 10-sep-2026 `rank` era `varchar` con claves en base 62
// (`0-9A-Za-z`), y quien las ordenaba era Postgres con `ORDER BY rank`. Ahí
// manda la colación: ese alfabeto mezcla cajas, así que el orden sólo salía
// bien si la base comparaba por bytes. Con una colación de locale las dos cajas
// se entremezclan y **el segundo elemento de un contenedor se pinta antes que
// el primero** — los primeros rangos eran «U» y «k».
//
// Producción estaba en `C` y acertaba, pero nada en el esquema lo pedía: era
// una propiedad de cómo alguien corrió `initdb` hace meses. Un `NUMERIC` no
// tiene colación, así que el orden pasa a ser una propiedad del tipo.
//
// Esto corre **antes de `AutoMigrate`**, y no es un detalle de estilo: GORM ve
// que el tipo declarado cambió e intenta el `ALTER COLUMN ... TYPE numeric`. Con
// una «U» dentro, Postgres no puede convertirla y el arranque muere. Primero se
// reescriben los valores, después se cambia el tipo.

// rankTable es una tabla con `rank` y la partición dentro de la que ese rango
// significa algo. Ordenar «todos los items» no querría decir nada: un rango sólo
// se compara con sus hermanos.
type rankTable struct {
	name      string
	partition string
}

// Los nombres son constantes de este fichero, no entran por parámetro: se
// interpolan en el SQL a mano porque una tabla no puede ir en un placeholder.
var rankTables = []rankTable{
	{"task_spaces", "org_id"},
	{"task_folders", "space_id"},
	{"task_lists", "space_id"},
	{"task_statuses", "list_id"},
	// El estado entra en la partición porque el tablero ordena dentro de cada
	// columna, no dentro de la lista entera.
	{"items", "list_id, status"},
	// La tabla vieja, de la que `unify-items-v1` sigue copiando mientras exista:
	// si su rango siguiera siendo texto, la copia a `items` fallaría al insertar.
	{"tasks", "list_id"},
}

func migrateRanks(db *gorm.DB) {
	// Una clave arbitraria y constante; sólo tiene que ser la misma en cada pod.
	// Sin esto, dos pods arrancando a la vez reescribirían los mismos rangos
	// mientras el otro cambia el tipo debajo.
	const lockKey = 0x2A11_6C0A
	if err := db.Exec(`SELECT pg_advisory_lock(?)`, lockKey).Error; err != nil {
		panic("rank migration: cannot take the lock: " + err.Error())
	}
	defer db.Exec(`SELECT pg_advisory_unlock(?)`, lockKey)

	for _, t := range rankTables {
		// La idempotencia la da **el esquema**, no un registro de que se hizo:
		// si la columna ya es `numeric`, está hecha. Una anotación en
		// `schema_backfills` diría lo que alguien creyó que pasó; esto dice lo
		// que hay. Y en una base recién creada la tabla todavía no existe —
		// `AutoMigrate` la creará ya numérica.
		var kind string
		db.Raw(`SELECT data_type FROM information_schema.columns
		        WHERE table_name = ? AND column_name = 'rank'`, t.name).Scan(&kind)
		if kind == "" || kind == "numeric" {
			continue
		}

		if err := renumberRanks(db, t); err != nil {
			panic("rank migration: renumbering " + t.name + ": " + err.Error())
		}
		if err := db.Exec(fmt.Sprintf(
			`ALTER TABLE %s ALTER COLUMN rank TYPE numeric USING rank::numeric`, t.name)).Error; err != nil {
			panic("rank migration: retyping " + t.name + ": " + err.Error())
		}
		lg.Info("rank migration: " + t.name + " now orders numerically")
	}
}

// renumberRanks reparte decimales nuevos **respetando el orden que hay**.
//
// El `ORDER BY rank` de dentro lee las claves viejas con la colación actual, que
// es la que ha estado pintando los tableros: lo que se conserva es exactamente
// lo que la gente ve hoy, no lo que debería haber visto.
//
// Los valores salen repartidos por el hueco: con N filas se usan tantos dígitos
// como tenga N, así que 3 filas quedan en 0,1 · 0,2 · 0,3 y siempre sobra sitio
// arriba, abajo y en medio. Un cero al final —0,10— es inofensivo: el número es
// el mismo, y `rank.Between` compara rellenando.
func renumberRanks(db *gorm.DB, t rankTable) error {
	return db.Exec(fmt.Sprintf(`
		UPDATE %[1]s AS target SET rank = fresh.value
		FROM (
			SELECT id, '0.' || lpad(
				(row_number() OVER (PARTITION BY %[2]s ORDER BY rank))::text,
				greatest(length((count(*) OVER (PARTITION BY %[2]s))::text), 1),
				'0') AS value
			FROM %[1]s
		) AS fresh
		WHERE target.id = fresh.id`, t.name, t.partition)).Error
}
