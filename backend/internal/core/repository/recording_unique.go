package repository

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

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
