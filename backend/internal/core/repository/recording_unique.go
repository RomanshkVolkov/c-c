package repository

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

// EnsureRecordingIndexes: una sala se graba una vez a la vez, y lo garantiza
// la base.
//
// Dos personas pulsando «grabar» a la vez son dos INSERT en vuelo, y comprobar
// antes en Go no sirve porque entre la comprobación y la escritura cabe la
// otra. Con el índice, la segunda choca y el servicio contesta «ya se está
// grabando», que es la verdad. Parcial sobre el estado vivo: las grabaciones de
// ayer no participan, o el índice impediría grabar una sala por segunda vez en
// su vida.
//
// **Por sala, no por espacio** (W3). Hasta que hubo reuniones con invitados
// cada espacio tenía una sala y daba igual; ahora un canal y una reunión que
// cuelga de él son dos salas del mismo espacio, y con el índice por espacio la
// segunda no se podría grabar mientras se graba la primera.
//
// Se llama desde `db.go` y desde las bases de las pruebas, para que las pruebas
// no copien a mano un índice que se queda atrás.
func EnsureRecordingIndexes(db *gorm.DB) error {
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_active_per_room
		ON recordings (room) WHERE status = 'recording'`).Error; err != nil {
		return err
	}
	return db.Exec(`DROP INDEX IF EXISTS idx_recording_active_per_space`).Error
}

// isUniqueViolation reconoce el choque contra un índice único de Postgres.
//
// Se mira el **código SQLSTATE** y no el texto del error: el texto lleva el
// nombre del índice y el idioma del servidor, y una comparación contra él se
// rompe el día que alguien renombre el índice — en silencio, devolviendo un 500
// donde tenía que haber un 409.
//
// La alternativa era encender `TranslateError` en la configuración de GORM, que
// cambiaría los errores que devuelve **todo** el repositorio a la vez. Un
// cambio global para un caso concreto es cómo se rompe algo que no se estaba
// tocando.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
