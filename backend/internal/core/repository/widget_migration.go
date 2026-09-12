package repository

import (
	"fmt"

	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"gorm.io/gorm"
)

// Se va la última huella del widget en la base.
//
// Hasta el 11-sep-2026 un proyecto de reportes podía ser de dos clases. La
// «web» entregaba su clave dentro del widget que el navegador se descargaba —
// pública por diseño— y lo único que la guardaba era `allowed_origins`, una
// lista que la comprobación **se saltaba entera** para cualquier petición sin
// cabecera `Origin`, o sea para cualquier `curl`. Por eso una clave así no
// podía leer ni clasificar: era de sólo escritura a propósito.
//
// Sin widget no queda ninguna clave suelta por un navegador, así que las dos
// columnas no las lee nadie. Se borran en vez de dejarlas: una columna que
// decía «esta llave es pública» y que ya no significa nada es exactamente lo
// que engaña a quien llegue después. GORM no borra columnas por su cuenta, de
// ahí que esto sea explícito.
//
// Corre junto a `migrateRanks`, antes de `AutoMigrate`, por la misma razón:
// toca el esquema a mano y conviene que el modelo y la tabla se encuentren ya
// de acuerdo.

// widgetColumns son las dos que sostenían la clave pública. Nombres constantes
// de este fichero: una columna no cabe en un placeholder.
var widgetColumns = []string{"platform", "allowed_origins"}

func dropWidgetColumns(db *gorm.DB) {
	// Clave arbitraria y constante; sólo tiene que ser la misma en cada pod,
	// para que dos arrancando a la vez no se pisen el ALTER.
	const lockKey = 0x3D_09_11_A1
	if err := db.Exec(`SELECT pg_advisory_lock(?)`, lockKey).Error; err != nil {
		panic("widget migration: cannot take the lock: " + err.Error())
	}
	defer db.Exec(`SELECT pg_advisory_unlock(?)`, lockKey)

	for _, column := range widgetColumns {
		// La idempotencia la da el esquema, no un registro de que se hizo: si
		// la columna no está, está hecho. Y en una base recién creada la tabla
		// todavía no existe — `AutoMigrate` la creará ya sin ellas.
		var found string
		db.Raw(`SELECT column_name FROM information_schema.columns
		        WHERE table_name = 'report_projects' AND column_name = ?`, column).Scan(&found)
		if found == "" {
			continue
		}
		if err := db.Exec(fmt.Sprintf(
			`ALTER TABLE report_projects DROP COLUMN %s`, column)).Error; err != nil {
			panic("widget migration: dropping " + column + ": " + err.Error())
		}
		lg.Info("widget migration: report_projects." + column + " dropped")
	}
}
