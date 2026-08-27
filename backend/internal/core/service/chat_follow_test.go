package service

import (
	"fmt"
	"sort"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Los ids son UUID de verdad y no «u-bea»: `ExtractMentions` sólo reconoce
// `cac:user/<uuid>`, así que con un id inventado el enlace no es una mención y
// el test de abajo mediría otra cosa mientras pasa en verde.
//
// Un mensaje corriente avisa a quien sigue el canal, y a nadie más.
//
// La alternativa —avisar a todo el espacio de cada línea— convierte la bandeja
// en una copia del chat: cuarenta mensajes de un canal ajeno tapan la mención
// que sí te buscaba. Seguir es cómo se dice «este sitio me importa».

type avisoEspiado struct {
	userID, kind, via, grupo string
}

type notificadorEspia struct{ avisos []avisoEspiado }

func (n *notificadorEspia) Notify(a domain.Aviso) {
	n.avisos = append(n.avisos, avisoEspiado{a.UserID, a.Kind, a.Via, a.Group})
}

// gruposDe: con qué clave de agrupación salió cada aviso de esa clase.
//
// El espía guarda el grupo **tal como lo puso quien notifica**, sin la red del
// servicio que lo deduce cuando falta: aquí interesa que el sitio que avisa lo
// esté poniendo de verdad, no que alguien lo rescate después.
func (n *notificadorEspia) gruposDe(kind string) []string {
	var out []string
	for _, a := range n.avisos {
		if a.kind == kind {
			out = append(out, a.grupo)
		}
	}
	return out
}

// viasDe: con qué etiqueta llegó cada aviso de esa clase.
func (n *notificadorEspia) viasDe(kind string) []string {
	var out []string
	for _, a := range n.avisos {
		if a.kind == kind {
			out = append(out, a.via)
		}
	}
	return out
}

func (n *notificadorEspia) paraQuien(kind string) []string {
	var out []string
	for _, a := range n.avisos {
		if a.kind == kind {
			out = append(out, a.userID)
		}
	}
	return out
}

func TestElMensajeCorrienteAvisaATodaLaOrganizacion(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	// Ana escribe y nadie ha tocado nada: bea y caro se enteran sin haber
	// pulsado ningún botón, que es de lo que iba el cambio.
	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "hola equipo"); err != nil {
		t.Fatal(err)
	}

	avisados := espia.paraQuien("chat:message")
	sort.Strings(avisados)
	if len(avisados) != 2 ||
		avisados[0] != "22222222-2222-4222-8222-222222222222" ||
		avisados[1] != "33333333-3333-4333-8333-333333333333" {
		t.Errorf("todos menos el autor; recibieron %v", avisados)
	}
}

// Y quien se sale deja de recibir, que es lo único que la tabla guarda ya.
func TestQuienSeSaleDejaDeRecibir(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	if err := svc.Unfollow("esp-1", "33333333-3333-4333-8333-333333333333"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "hola"); err != nil {
		t.Fatal(err)
	}

	avisados := espia.paraQuien("chat:message")
	if len(avisados) != 1 || avisados[0] != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("caro se salió y bea no; recibieron %v", avisados)
	}
}

// Salirse de un canal no te saca de los demás: la fila es por espacio.
func TestSalirseDeUnCanalNoTeSacaDeOtro(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	if err := NewChatService(repo, nil).Unfollow("esp-1", "33333333-3333-4333-8333-333333333333"); err != nil {
		t.Fatal(err)
	}
	quienes, err := repo.Followers("esp-2")
	if err != nil {
		t.Fatal(err)
	}
	if len(quienes) != 3 {
		t.Errorf("el otro canal sigue con los tres; tiene %v", quienes)
	}
}

// Y alguien de otra organización nunca entra en la lista, se salga o no.
func TestNadieDeOtraOrganizacionRecibe(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	quienes, err := repository.NewChatRepository(db).Followers("esp-otra")
	if err != nil {
		t.Fatal(err)
	}
	if len(quienes) != 1 || quienes[0] != "44444444-4444-4444-8444-444444444444" {
		t.Errorf("sólo el miembro de esa org; salieron %v", quienes)
	}
}

func TestQuienEscribeNoSeAvisaASiMismo(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "hola"); err != nil {
		t.Fatal(err)
	}
	// Los demás sí lo reciben; lo que se comprueba es que ana no está entre
	// ellos. Antes bastaba con «la lista está vacía» porque sólo el autor
	// seguía el canal — con todos siguiendo por defecto, esa forma de mirarlo
	// habría dejado de probar nada.
	for _, uid := range espia.paraQuien("chat:message") {
		if uid == "11111111-1111-4111-8111-111111111111" {
			t.Error("avisarte de lo que acabas de escribir es la app hablando sola")
		}
	}
}

// A quien nombraron le llega su mención, y no además un aviso de mensaje: es la
// misma línea contada dos veces.
func TestAQuienNombranNoLeLlegaTambienElAvisoCorriente(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "oye [bea](cac:user/22222222-2222-4222-8222-222222222222) mira esto"); err != nil {
		t.Fatal(err)
	}
	if m := espia.paraQuien("chat:mention"); len(m) != 1 || m[0] != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("la mención tiene que llegar, llegó a %v", m)
	}
	if m := espia.paraQuien("chat:message"); len(m) != 1 || m[0] != "33333333-3333-4333-8333-333333333333" {
		t.Errorf("a bea la nombraron, así que sólo caro recibe el corriente; %v", m)
	}
}

// Dejar de seguir se nota, y seguir dos veces no es un error.
func TestSeguirEsIdempotenteYDejarDeSeguirCalla(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	for i := 0; i < 2; i++ {
		if err := svc.Unfollow("esp-1", "22222222-2222-4222-8222-222222222222"); err != nil {
			t.Fatalf("salirse dos veces no puede fallar: %v", err)
		}
	}
	quienes, _ := repo.Followers("esp-1")
	if len(quienes) != 2 {
		t.Errorf("salirse dos veces saca a uno, quedaron %v", quienes)
	}
	// Y volver a entrar deshace exactamente eso.
	if err := svc.Follow("esp-1", "22222222-2222-4222-8222-222222222222"); err != nil {
		t.Fatal(err)
	}
	quienes, _ = repo.Followers("esp-1")
	if len(quienes) != 3 {
		t.Errorf("al volver está de nuevo, quedaron %v", quienes)
	}
}

func chatFollowDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_chat_follow"
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
		&domain.TaskSpace{}, &domain.ChatMessage{}, &domain.SpaceMute{}); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	must := func(tx *gorm.DB) {
		t.Helper()
		if tx.Error != nil {
			t.Fatalf("la fixture no se pudo insertar: %v", tx.Error)
		}
	}
	must(db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at) VALUES
		('11111111-1111-4111-8111-111111111111','ana','a@x.io','x',?,?), ('22222222-2222-4222-8222-222222222222','bea','b@x.io','x',?,?),
		('33333333-3333-4333-8333-333333333333','caro','c@x.io','x',?,?)`, ahora, ahora, ahora, ahora, ahora, ahora))
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
		VALUES ('org-1','Uno','uno',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
		('org-1','11111111-1111-4111-8111-111111111111','admin',?), ('org-1','22222222-2222-4222-8222-222222222222','member',?), ('org-1','33333333-3333-4333-8333-333333333333','member',?)`,
		ahora, ahora, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-1','org-1','Uno','#fff','m',?,?), ('esp-2','org-1','Dos','#fff','n',?,?)`,
		ahora, ahora, ahora, ahora))
	// Otra organización con su propia persona: la pertenencia es lo que decide
	// quién recibe, así que hace falta alguien de fuera para probar que no cruza.
	must(db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at) VALUES
		('44444444-4444-4444-8444-444444444444','dani','d@x.io','x',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
		VALUES ('org-2','Dos','dos',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		VALUES ('org-2','44444444-4444-4444-8444-444444444444','admin',?)`, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-otra','org-2','Ajeno','#fff','m',?,?)`, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
