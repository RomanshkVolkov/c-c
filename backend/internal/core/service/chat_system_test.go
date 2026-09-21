package service

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una línea que dice venir de cac.
//
// Todo lo de este fichero defiende la misma propiedad, mirada desde sitios
// distintos: **un mensaje del sistema tiene que ser imposible de fabricar y de
// reescribir**. Si cualquiera de las dos falla, la línea no vale más que una en
// la que alguien escribió «esto lo dice el servidor».

// Nadie de fuera elige el `kind`.
//
// Dos comprobaciones y no una, porque hay dos maneras de romperlo y sólo una es
// visible leyendo el handler:
//
//   - Que la petición gane el campo. Con `kind` en `ChatMessageRequest`, un
//     `POST` con `"kind":"system"` escribe una línea del sistema.
//   - Que `Post` gane el parámetro. Entonces el handler puede pasárselo, y
//     basta con que alguien lo cablee «para reusar código».
//
// El mutante que mata: cualquiera de las dos. La primera se caza por reflexión
// sobre el tipo, la segunda leyendo el árbol del paquete del handler.
func TestOnlyTheServiceWritesASystemMessage(t *testing.T) {
	req := reflect.TypeOf(domain.ChatMessageRequest{})
	for i := 0; i < req.NumField(); i++ {
		if strings.EqualFold(req.Field(i).Name, "kind") {
			t.Error("ChatMessageRequest tiene un campo `kind`: con eso, una línea " +
				"del sistema es una línea que puede escribir cualquiera")
		}
	}

	// Y ningún handler llama a PostSystem. El único llamante legítimo es el
	// servicio de grabación, que no está detrás de una petición de nadie.
	root := filepath.Join("..", "..", "adapters")
	var offenders []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".go") ||
			strings.HasSuffix(d.Name(), "_test.go") {
			return err
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("no se pudo leer %s: %v", path, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if ok && sel.Sel.Name == "PostSystem" {
				offenders = append(offenders, path+":"+fmt.Sprint(fset.Position(sel.Pos()).Line))
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range offenders {
		// `http/recording.go` sólo lo *engancha* (WithAnnouncer); llamarlo desde
		// un handler es otra cosa: ahí hay una petición de alguien detrás.
		if strings.Contains(c, filepath.Join("adapters", "handler")) {
			t.Errorf("%s llama a PostSystem: un handler está detrás de una petición, "+
				"y el sistema no habla porque se lo pidan", c)
		}
	}
}

// Un mensaje del sistema no es de nadie para reescribirlo.
//
// Ésta es la que cierra el diseño. La fila lleva de autor a quien grabó, así
// que la comprobación de autoría —la única que había— **le dice que sí**: quien
// grabó vería Editar y Retirar sobre la línea que anuncia su propia grabación.
// Un mensaje que parece infalsificable y cuyo texto se puede cambiar es peor
// que no tenerlo.
//
// Los mutantes que matan: quitar la guarda de `Edit` o la de `Withdraw`;
// ponerla **después** de `authoredBy` (entonces el autor pasa); o dejar entrar
// al superadmin, que aquí no es la excepción que es en todo lo demás.
func TestASystemMessageIsNobodysToRewrite(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)

	m, err := svc.PostSystem("space-1", "org-1", "u-ana", "la grabación está lista", "lista")
	if err != nil {
		t.Fatal(err)
	}
	if m.Kind != domain.ChatKindSystem {
		t.Fatalf("PostSystem escribe `system`, escribió %q", m.Kind)
	}

	// Quien grabó es el autor de la fila, y aun así no puede tocarla.
	if err := svc.Edit(m.ID, "u-ana", false, "la grabación se borró"); err != ErrNotAUserMessage {
		t.Errorf("el autor de la fila tampoco la reescribe, got %v", err)
	}
	if err := svc.Withdraw(m.ID, "u-ana", false); err != ErrNotAUserMessage {
		t.Errorf("ni la retira, got %v", err)
	}
	// Ni el superadmin: esto es un registro, no las palabras de una persona.
	if err := svc.Edit(m.ID, "u-root", true, "otra cosa"); err != ErrNotAUserMessage {
		t.Errorf("un superadmin limpia lo que dijo alguien, no lo que pasó: %v", err)
	}
	if err := svc.Withdraw(m.ID, "u-root", true); err != ErrNotAUserMessage {
		t.Errorf("tampoco retirándolo: %v", err)
	}

	// Y sigue en el canal después de todos esos intentos.
	msgs, err := repository.NewChatRepository(db).List("space-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Body != "la grabación está lista" {
		t.Fatalf("la línea sigue donde estaba y dice lo mismo: %+v", bodies(msgs))
	}
}

// El historial trae el `kind`.
//
// El mutante que mata: quitar `m.kind` del `Select` literal de `List`. Es el
// fallo que ese estilo invita, y es silencioso en el peor sitio: el mensaje
// recién publicado sale bien —lo construyó el servicio— y al recargar el canal
// sale como un mensaje humano firmado por quien grabó.
func TestTheHistoryCarriesTheKind(t *testing.T) {
	db, cleanup := chatDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	if _, err := svc.Post("space-1", "org-1", "u-ana", "lo de siempre"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := svc.PostSystem("space-1", "org-1", "u-ana", "lo automático", "lo automático"); err != nil {
		t.Fatal(err)
	}

	msgs, err := repo.List("space-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("dos líneas: %+v", bodies(msgs))
	}
	if msgs[0].Kind != domain.ChatKindUser {
		t.Errorf("la de una persona vuelve como `user`, volvió %q", msgs[0].Kind)
	}
	if msgs[1].Kind != domain.ChatKindSystem {
		t.Errorf("y la del sistema como `system`, volvió %q — recargar el canal "+
			"la convierte en un mensaje de quien grabó", msgs[1].Kind)
	}
}

// El sistema no habla en nombre de nadie.
//
// `anotarAvisos` monta «autor: adelanto», que es como se lee un chat. Aplicado
// a una línea del sistema da «Jose: la grabación está lista» — que dice
// exactamente lo contrario de lo que la línea es, y encima delante de la
// persona a la que se está atribuyendo.
//
// Los mutantes que matan: devolver el prefijo del autor (quitar el corte de
// `quienHabla`), o cambiar la clase del aviso a `chat:system` — que no está en
// `Allows()`, así que caería en la casilla DESCONOCIDA de las preferencias y
// salirse del canal dejaría de silenciarla.
func TestTheSystemSpeaksForNobody(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	spy := &spyWithBodies{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(spy)

	const ana = "11111111-1111-4111-8111-111111111111"
	if _, err := svc.PostSystem("esp-1", "org-1", ana,
		"The recording of this call is ready — [watch it](cac:recording/x).",
		"The recording of this call is ready."); err != nil {
		t.Fatal(err)
	}

	if len(spy.notices) == 0 {
		t.Fatal("alguien tiene que enterarse: es la mitad de lo que esto arregla")
	}
	for _, a := range spy.notices {
		if a.kind != "chat:message" {
			t.Errorf("la clase de siempre, para que `Allows()` y salirse del canal "+
				"sigan valiendo; llegó %q", a.kind)
		}
		if strings.Contains(a.body, "ana") || strings.Contains(a.body, ":") {
			t.Errorf("sin «alguien: » delante — el sistema no es una persona: %q", a.body)
		}
		if strings.Contains(a.body, "](") {
			t.Errorf("y sin markdown crudo, que la bandeja no pinta: %q", a.body)
		}
		if a.userID == ana {
			t.Error("a quien grabó no se le avisa de su propia grabación")
		}
	}
}

// noticeWithBody: como el espía de `chat_follow_test.go`, pero guardando el
// texto. Aquí lo que se mide es justo lo que aquél tira.
type noticeWithBody struct{ userID, kind, body string }

type spyWithBodies struct{ notices []noticeWithBody }

func (e *spyWithBodies) Notify(a domain.Aviso) {
	e.notices = append(e.notices, noticeWithBody{a.UserID, a.Kind, a.Body})
}

// Una base con organización y miembros, que es lo que `Followers` necesita para
// que haya a quién avisar.
func chatSystemDB(t *testing.T) (*gorm.DB, func()) {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_chat_system"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.Organization{}, &domain.OrgMembership{},
		&domain.TaskSpace{}, &domain.ChatMessage{}, &domain.ChatAttachment{},
		&domain.SpaceMute{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	must := func(tx *gorm.DB) {
		if tx.Error != nil {
			t.Fatal(tx.Error)
		}
	}
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
		VALUES ('org-1','Uno','uno',?,?)`, now, now))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-1','org-1','portento','#fff','0.5',?,?)`, now, now))
	for _, u := range []struct{ id, nombre string }{
		{"11111111-1111-4111-8111-111111111111", "ana"},
		{"22222222-2222-4222-8222-222222222222", "bea"},
	} {
		must(db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at)
			VALUES (?,?,?,'x',?,?)`, u.id, u.nombre, u.nombre+"@x.dev", now, now))
		must(db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES ('org-1',?,'member',?)`, u.id, now))
	}
	return db, func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
