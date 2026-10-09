package repository

import (
	"gorm.io/gorm"

	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

/*
EnsureSearchIndexes monta la búsqueda de texto completo: la documentación, las
tareas (título, descripción y comentarios) y las notas.

**Configuración `cac_simple` = `simple` + `unaccent`.** La documentación mezcla
castellano e inglés y está llena de identificadores (`pocna-jobs`, `CAC_TOKEN`,
nombres de host). Un lematizador de un idioma estropearía los del otro y
partiría los identificadores; `simple` no lematiza ni tira palabras vacías («no»
sigue siendo buscable), y `unaccent` hace que «configuracion» encuentre
«Configuración». Lo que no lematiza lo cubre la búsqueda por prefijo
(`domain.SearchTSQuery`).

Si la extensión no se puede crear —un Postgres sin contrib, o un usuario sin
permiso—, la configuración se crea sin ella y se avisa en el log: la búsqueda
funciona igual, sólo que distingue acentos. Degradado, nunca roto. En producción
hay que crearla una vez como superusuario: `CREATE EXTENSION unaccent;`.

**Columnas generadas** (`search tsvector … STORED`) con índice GIN: se calculan
solas en cada escritura, así que ningún camino que guarde texto tiene que
acordarse de ellas. El struct **no** las nombra (ver `domain.DocPage`): GORM
intentaría escribirlas y la inserción fallaría.

Idempotente: se llama al arrancar y desde las bases de prueba.
*/
func EnsureSearchIndexes(db *gorm.DB) error {
	unaccent := db.Exec(`CREATE EXTENSION IF NOT EXISTS unaccent`).Error == nil
	if !unaccent {
		// Puede que ya exista aunque no se pueda crear: crearla pide permisos
		// que usarla no pide.
		var n int64
		db.Raw(`SELECT count(*) FROM pg_extension WHERE extname = 'unaccent'`).Scan(&n)
		unaccent = n > 0
	}
	if !unaccent {
		lg.Warn("search: no unaccent extension — full-text search will be accent-sensitive " +
			"(run CREATE EXTENSION unaccent as a superuser)")
	}
	if err := db.Exec(`DO $$ BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'cac_simple') THEN
			CREATE TEXT SEARCH CONFIGURATION cac_simple (COPY = simple);
		END IF;
	END $$`).Error; err != nil {
		return err
	}
	if unaccent {
		if err := db.Exec(`ALTER TEXT SEARCH CONFIGURATION cac_simple
			ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
			WITH unaccent, simple`).Error; err != nil {
			return err
		}
	}
	// Por tabla, y sólo las que existen: una base de pruebas monta las tablas
	// que necesita, no todas, y la columna de una tabla que no está no es un
	// error de esta base.
	porTabla := []struct {
		table string
		stmts []string
	}{
		{"doc_tabs", []string{
			// La pestaña es la portada: peso B, como el cuerpo de una página.
			`ALTER TABLE doc_tabs ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
				(setweight(to_tsvector('cac_simple'::regconfig, coalesce(body, '')), 'B')) STORED`,
			`CREATE INDEX IF NOT EXISTS idx_doc_tabs_search ON doc_tabs USING GIN (search)`,
		}},
		{"doc_pages", []string{
			// En una página, el título pesa más que el cuerpo: buscar «Nereus»
			// tiene que traer la página que se llama así antes que las que lo
			// nombran.
			`ALTER TABLE doc_pages ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
				(setweight(to_tsvector('cac_simple'::regconfig, coalesce(title, '')), 'A') ||
				 setweight(to_tsvector('cac_simple'::regconfig, coalesce(body, '')), 'B')) STORED`,
			`CREATE INDEX IF NOT EXISTS idx_doc_pages_search ON doc_pages USING GIN (search)`,
		}},
		{"items", []string{
			// Una tarea, como una página: el título pesa más que la descripción.
			`ALTER TABLE items ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
				(setweight(to_tsvector('cac_simple'::regconfig, coalesce(title, '')), 'A') ||
				 setweight(to_tsvector('cac_simple'::regconfig, coalesce(description, '')), 'B')) STORED`,
			`CREATE INDEX IF NOT EXISTS idx_items_search ON items USING GIN (search)`,
		}},
		{"item_comments", []string{
			// Los comentarios, por debajo de los dos: un acierto en el hilo de
			// hace un año no puede tapar a la tarea que se llama así (#89).
			`ALTER TABLE item_comments ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
				(setweight(to_tsvector('cac_simple'::regconfig, coalesce(body, '')), 'C')) STORED`,
			`CREATE INDEX IF NOT EXISTS idx_item_comments_search ON item_comments USING GIN (search)`,
		}},
		{"notes", []string{
			`ALTER TABLE notes ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
				(setweight(to_tsvector('cac_simple'::regconfig, coalesce(title, '')), 'A') ||
				 setweight(to_tsvector('cac_simple'::regconfig, coalesce(body, '')), 'B')) STORED`,
			`CREATE INDEX IF NOT EXISTS idx_notes_search ON notes USING GIN (search)`,
		}},
	}
	for _, t := range porTabla {
		var existe bool
		if err := db.Raw(`SELECT to_regclass(?) IS NOT NULL`, t.table).Scan(&existe).Error; err != nil {
			return err
		}
		if !existe {
			continue
		}
		for _, s := range t.stmts {
			if err := db.Exec(s).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
