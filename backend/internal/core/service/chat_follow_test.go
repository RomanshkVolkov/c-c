package service

import (
	"fmt"
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
	userID, kind string
}

type notificadorEspia struct{ avisos []avisoEspiado }

func (n *notificadorEspia) Notify(userID, orgID, kind, title, body, link string) {
	n.avisos = append(n.avisos, avisoEspiado{userID, kind})
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

func TestElMensajeCorrienteAvisaSoloAQuienSigueElCanal(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	espia := &notificadorEspia{}
	svc := NewChatService(repo, nil).WithNotifier(espia)

	if err := svc.Follow("esp-1", "22222222-2222-4222-8222-222222222222"); err != nil {
		t.Fatal(err)
	}
	// Ana escribe. Bea sigue el canal; caro no.
	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "hola equipo"); err != nil {
		t.Fatal(err)
	}

	avisados := espia.paraQuien("chat:message")
	if len(avisados) != 1 || avisados[0] != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("sólo quien sigue el canal debe recibirlo, recibieron %v", avisados)
	}
}

func TestQuienEscribeNoSeAvisaASiMismo(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	// Ana sigue su propio canal, que es lo normal.
	if err := svc.Follow("esp-1", "11111111-1111-4111-8111-111111111111"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "hola"); err != nil {
		t.Fatal(err)
	}
	if len(espia.paraQuien("chat:message")) != 0 {
		t.Error("avisarte de lo que acabas de escribir es la app hablando sola")
	}
}

// A quien nombraron le llega su mención, y no además un aviso de mensaje: es la
// misma línea contada dos veces.
func TestAQuienNombranNoLeLlegaTambienElAvisoCorriente(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	if err := svc.Follow("esp-1", "22222222-2222-4222-8222-222222222222"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Post("esp-1", "org-1", "11111111-1111-4111-8111-111111111111", "oye [bea](cac:user/22222222-2222-4222-8222-222222222222) mira esto"); err != nil {
		t.Fatal(err)
	}
	if m := espia.paraQuien("chat:mention"); len(m) != 1 || m[0] != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("la mención tiene que llegar, llegó a %v", m)
	}
	if len(espia.paraQuien("chat:message")) != 0 {
		t.Error("nombrada y avisada por el mismo mensaje es contarlo dos veces")
	}
}

// Dejar de seguir se nota, y seguir dos veces no es un error.
func TestSeguirEsIdempotenteYDejarDeSeguirCalla(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)

	for i := 0; i < 2; i++ {
		if err := svc.Follow("esp-1", "22222222-2222-4222-8222-222222222222"); err != nil {
			t.Fatalf("seguir dos veces no puede fallar: %v", err)
		}
	}
	quienes, _ := repo.Followers("esp-1")
	if len(quienes) != 1 {
		t.Errorf("seguir dos veces deja un seguidor, dejó %d", len(quienes))
	}
	if err := svc.Unfollow("esp-1", "22222222-2222-4222-8222-222222222222"); err != nil {
		t.Fatal(err)
	}
	quienes, _ = repo.Followers("esp-1")
	if len(quienes) != 0 {
		t.Errorf("tras dejarlo no queda nadie, quedaron %d", len(quienes))
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
		&domain.TaskSpace{}, &domain.ChatMessage{}, &domain.SpaceFollower{}); err != nil {
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
		VALUES ('esp-1','org-1','Uno','#fff','m',?,?)`, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
