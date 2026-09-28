package repository

import (
	"fmt"

	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"gorm.io/gorm"
)

// canonicalizeItemPriorities deja una sola forma de decir «prioridad media».
//
// Lo que se guarda es `medium` (ver domain.ItemPriority); `normal` es sólo como
// se pide y como contesta la API de tareas. Pero editar una tarea guardaba la
// entrada cruda, así que las que alguien había tocado quedaron con `normal`
// mientras las recién creadas decían `medium`. Dos nombres para lo mismo en la
// misma columna, y el orden de «mi trabajo» sólo sabía de uno (#83).
//
// Idempotente por construcción: en cuanto una fila se reescribe, el WHERE deja
// de casarla, así que un redespliegue cuesta una consulta que no toca nada. Va
// después de migrateItems porque es la tabla que ésta deja escrita.
func canonicalizeItemPriorities(db *gorm.DB) {
	res := db.Exec(`UPDATE items SET priority = 'medium' WHERE priority = 'normal'`)
	if res.Error != nil {
		lg.Error("canonicalize item priorities: " + res.Error.Error())
		return
	}
	if res.RowsAffected > 0 {
		lg.Info(fmt.Sprintf("items: %d priorities normal → medium", res.RowsAffected))
	}
}
