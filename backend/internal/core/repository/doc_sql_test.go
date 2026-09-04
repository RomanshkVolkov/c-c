package repository

import (
	"fmt"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// El SQL de la documentación que nadie más comprueba.
//
// Casi todo lo demás de este módulo se prueba en el dominio, con funciones
// puras, precisamente porque estas pruebas se saltan sin base. Pero tres cosas
// de aquí sólo existen como SQL escrito a mano, y de ésas el compilador no dice
// nada: la concatenación de `AppendTab`, los tres `LEFT JOIN` del buscador y el
// índice único parcial que impide una decisión duplicada.
//
// Con `DB_HOST` puesto se corren; sin él se saltan, como el resto.
func docSQLDB(t *testing.T) (*gorm.DB, func()) {
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
	// Una base desechable, como el resto de pruebas de este paquete: sin esto,
	// apuntar `DB_HOST` a algo real le deja dentro las filas de la prueba.
	const name = "cac_test_doc_sql"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&domain.TaskSpace{}, &domain.TaskFolder{}, &domain.TaskList{},
		&domain.Doc{}, &domain.DocTab{}, &domain.DocVersion{}, &domain.Decision{},
	); err != nil {
		t.Fatal(err)
	}
	// El índice parcial no lo pone AutoMigrate: la cláusula WHERE no cabe en una
	// etiqueta de GORM. Es el mismo statement que corre al arrancar.
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_comment
		ON decisions (origin_comment_id) WHERE origin_comment_id <> ''`).Error; err != nil {
		t.Fatal(err)
	}

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

func TestDocSQL(t *testing.T) {
	db, cerrar := docSQLDB(t)
	defer cerrar()

	sp := &domain.TaskSpace{OrgID: "o1", Name: "Portento"}
	if err := db.Create(sp).Error; err != nil {
		t.Fatal(err)
	}
	l := &domain.TaskList{SpaceID: sp.ID, Name: "tasks"}
	if err := db.Create(l).Error; err != nil {
		t.Fatal(err)
	}
	r := NewDocRepository(db)
	doc := func() *domain.Doc {
		d, err := r.Find(domain.DocOwnerList, l.ID)
		if err != nil || d == nil {
			t.Fatalf("sin documento: %v", err)
		}
		return d
	}
	cuerpo := func(k domain.DocTabKey) string {
		tabs, err := r.Tabs(doc().ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, x := range tabs {
			if x.Key == k {
				return x.Body
			}
		}
		return ""
	}

	t.Run("añadir concatena en vez de reemplazar", func(t *testing.T) {
		if _, err := r.SaveTab("o1", domain.DocOwnerList, l.ID, domain.DocRunbook, "1. Parar", "u1"); err != nil {
			t.Fatal(err)
		}
		if _, err := r.AppendTab("o1", domain.DocOwnerList, l.ID, domain.DocRunbook, "2. Arrancar", "u2"); err != nil {
			t.Fatal(err)
		}
		if got := cuerpo(domain.DocRunbook); got != "1. Parar\n\n2. Arrancar" {
			t.Fatalf("la concatenación salió mal: %q", got)
		}
	})

	// En Postgres `NULL || 'x'` es `NULL`. Sin el `COALESCE`, una fila con el
	// cuerpo nulo —las hay de antes de que esta tabla existiera— se vaciaría en
	// vez de crecer, y lo que hubiera dentro se perdería sin que nada fallara.
	t.Run("añadir sobre un cuerpo nulo no lo borra", func(t *testing.T) {
		d := doc()
		if err := db.Create(&domain.DocTab{DocID: d.ID, Key: domain.DocLinks}).Error; err != nil {
			t.Fatal(err)
		}
		db.Exec("UPDATE doc_tabs SET body = NULL WHERE doc_id = ? AND key = ?", d.ID, domain.DocLinks)
		if _, err := r.AppendTab("o1", domain.DocOwnerList, l.ID, domain.DocLinks, "la bóveda", "u1"); err != nil {
			t.Fatal(err)
		}
		if got := cuerpo(domain.DocLinks); got == "" {
			t.Fatal("el cuerpo se vació en vez de crecer")
		}
	})

	t.Run("el historial guarda el texto anterior, no el nuevo", func(t *testing.T) {
		if _, err := r.SaveTab("o1", domain.DocOwnerList, l.ID, domain.DocRunbook, "todo de nuevo", "u9"); err != nil {
			t.Fatal(err)
		}
		vs, err := r.Versions(doc().ID, domain.DocRunbook, 10)
		if err != nil || len(vs) == 0 {
			t.Fatalf("sin historial: %v (%d entradas)", err, len(vs))
		}
		if vs[0].Body == "todo de nuevo" {
			t.Fatal("guardó el estado nuevo; restaurar no llevaría a ninguna parte")
		}
	})

	// El registro es append-only: una entrada de más se queda para siempre.
	t.Run("un reintento no deja dos decisiones iguales", func(t *testing.T) {
		nueva := func() *domain.Decision {
			return &domain.Decision{
				DocID: doc().ID, Title: "Postgres, no Mongo",
				Origin: domain.DecisionFromTask, OriginTaskID: "t1", OriginCommentID: "c1",
			}
		}
		a, err := r.AddDecision(nueva())
		if err != nil {
			t.Fatal(err)
		}
		b, err := r.AddDecision(nueva())
		if err != nil {
			t.Fatal(err)
		}
		if a.ID != b.ID {
			t.Fatal("el reintento escribió una segunda entrada")
		}
	})

	// Tres `LEFT JOIN` y `key` como alias, que es palabra sospechosa en SQL.
	t.Run("el buscador resuelve el nombre del nodo", func(t *testing.T) {
		if _, err := r.SaveTab("o1", domain.DocOwnerList, l.ID, domain.DocOverview,
			"una palabra esdrujula", "u1"); err != nil {
			t.Fatal(err)
		}
		hits, err := NewSearchRepository(db).Docs("esdrujula", "o1", 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) == 0 {
			t.Fatal("no encontró lo que acaba de escribirse")
		}
		if hits[0].Title != "tasks" {
			t.Fatalf("el nombre del nodo no se resolvió: %q", hits[0].Title)
		}
	})

	// El hash tiene que corresponder a lo que quedó en la fila, no a lo que quien
	// escribió creía que estaba dejando: al añadir al final la concatenación la
	// hace la base —justamente para no leer antes— así que el resultado sólo se
	// conoce después. Un hash que no corresponde a ninguna versión hace que el
	// siguiente guardado se acepte o se rechace por razones inventadas.
	t.Run("el hash corresponde al cuerpo que quedó", func(t *testing.T) {
		hashDe := func(k domain.DocTabKey) (string, string) {
			tabs, err := r.Tabs(doc().ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, x := range tabs {
				if x.Key == k {
					return x.BodyHash, x.Body
				}
			}
			return "", ""
		}

		// Después de guardar, y **antes** de añadir nada.
		//
		// Comprobarlo sólo al final no dice nada: el `append` reescribe el hash,
		// así que un `SaveTab` que no lo escribiera pasaría igual. Y sin hash al
		// guardar, `DocSaveConflicts` devuelve siempre `false` — la detección de
		// conflictos queda apagada para toda sección que nadie haya ampliado, en
		// silencio y para siempre.
		if _, err := r.SaveTab("o1", domain.DocOwnerList, l.ID, domain.DocDecisions, "uno", "u1"); err != nil {
			t.Fatal(err)
		}
		if h, b := hashDe(domain.DocDecisions); h == "" || h != HashBody(b) {
			t.Fatalf("crear la sección no dejó hash: %q para %q", h, b)
		}

		// Y otra vez, que es un camino distinto: la primera escritura **crea** la
		// fila y la segunda la actualiza. Comprobar sólo la primera deja la mitad
		// sin mirar, y es la mitad por la que pasa todo lo demás.
		if _, err := r.SaveTab("o1", domain.DocOwnerList, l.ID, domain.DocDecisions, "uno corregido", "u1"); err != nil {
			t.Fatal(err)
		}
		if h, b := hashDe(domain.DocDecisions); h != HashBody(b) {
			t.Fatalf("volver a guardar dejó un hash viejo: %q para %q", h, b)
		}

		if _, err := r.AppendTab("o1", domain.DocOwnerList, l.ID, domain.DocDecisions, "dos", "u1"); err != nil {
			t.Fatal(err)
		}
		if h, b := hashDe(domain.DocDecisions); h != HashBody(b) {
			t.Fatalf("añadir dejó un hash que no es el de lo que hay: %q para %q", h, b)
		}
	})

	t.Run("el índice marca la lista con documentación", func(t *testing.T) {
		m, err := r.HasDoc("o1")
		if err != nil {
			t.Fatal(err)
		}
		if !m["list:"+l.ID].Written {
			t.Fatal("la lista no aparece marcada")
		}
	})
}
