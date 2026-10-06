package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
La campana al teléfono (W2). Lo que se fija: que lo que llega al teléfono es
exactamente la fila de la campana (título traducido, enlace, grupo como
etiqueta, id para marcarla leída), que las preferencias sólo pueden quitar, que
nunca llega a un dispositivo de otra persona, y que un dispositivo muerto se
olvida.
*/

// envio es lo que se mandó a un dispositivo, contado por un transporte falso.
type envio struct {
	endpoint string
	msg      domain.PushMessage
	topic    string
	opts     PushOptions
}

type transporteFalso struct {
	mu     sync.Mutex
	envios []envio
	status int
}

func (f *transporteFalso) Send(sub domain.PushSubscription, payload []byte, topic string, opts PushOptions) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var m domain.PushMessage
	_ = json.Unmarshal(payload, &m)
	f.envios = append(f.envios, envio{endpoint: sub.Endpoint, msg: m, topic: topic, opts: opts})
	if f.status == 0 {
		return 201, nil
	}
	return f.status, nil
}

func pushDB(t *testing.T) (*gorm.DB, *repository.PushRepository) {
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
	const name = "cac_test_push"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Notification{}, &domain.NotificationPrefs{}, &domain.PushSubscription{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		SetPush(nil)
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})
	return db, repository.NewPushRepository(db)
}

func suscribir(t *testing.T, p *PushService, user, endpoint string) {
	t.Helper()
	req := domain.PushSubscribeRequest{Endpoint: endpoint}
	req.Keys.P256dh, req.Keys.Auth = "p256", "auth"
	if err := p.Subscribe(user, "Mozilla/5.0 (Android)", req); err != nil {
		t.Fatal(err)
	}
}

func montarPush(t *testing.T) (*NotificationService, *PushService, *transporteFalso, *repository.PushRepository, *gorm.DB) {
	db, repo := pushDB(t)
	fake := &transporteFalso{}
	p := NewPushService(repo, "", "", "").WithTransport(fake, "BPublica")
	SetPush(p)
	return NewNotificationService(repository.NewNotificationRepository(db)), p, fake, repo, db
}

// Lo que llega al teléfono es la fila de la campana, no otra cosa. Mutantes:
// empujar antes de escribir la fila (sin id), mandar el título sin traducir, o
// no pasar la clave de grupo como etiqueta.
func TestTheBellReachesThePhone(t *testing.T) {
	svc, p, fake, _, db := montarPush(t)
	suscribir(t, p, "u-ana", "https://push.example/ana")
	svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: "task:comment",
		TitleKey: "notify.reply.by", TitleArgs: map[string]string{"who": "Bea"},
		Body: "Arreglar el login", Link: "/tasks?task=it-1", Group: domain.ItemGroup("it-1"), Label: "Arreglar el login"})

	if len(fake.envios) != 1 {
		t.Fatalf("%d envíos, se esperaba 1", len(fake.envios))
	}
	var n domain.Notification
	db.First(&n)
	m := fake.envios[0].msg
	if m.ID != n.ID || m.ID == "" {
		t.Errorf("el aviso no lleva el id de su fila: %q vs %q", m.ID, n.ID)
	}
	if m.Title != "Bea replied" || m.Title != n.Title {
		t.Errorf("el título no es el de la fila, traducido: %q", m.Title)
	}
	if m.Link != "/tasks?task=it-1" || m.Body != "Arreglar el login" || m.Kind != "task:comment" || m.OrgID != "org-1" {
		t.Errorf("el aviso no dice lo mismo que la campana: %+v", m)
	}
	if m.Tag != domain.ItemGroup("it-1") {
		t.Errorf("la etiqueta tiene que ser el grupo de la campana, es %q", m.Tag)
	}
	if fake.envios[0].topic != pushTopic(domain.ItemGroup("it-1")) {
		t.Errorf("el tema no es el resumen del grupo: %q", fake.envios[0].topic)
	}
}

// Las preferencias sólo quitan. Lo que la campana calla no va al teléfono;
// `pushQuiet` calla el teléfono sin tocar la campana; y el CI no va al teléfono
// salvo que se pida. Mutantes: empujar sin mirar `PushAllows`; dejar pasar el
// CI por defecto; que `pushQuiet` calle también la campana.
func TestPhonePreferencesOnlyTakeAway(t *testing.T) {
	svc, p, fake, _, db := montarPush(t)
	suscribir(t, p, "u-ana", "https://push.example/ana")
	aviso := func(kind string) {
		svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: kind, Title: kind, Link: "/x"})
	}

	prefs := domain.DefaultPrefs("u-ana")
	prefs.DMs = false
	svc.SavePrefs(prefs)
	aviso("dm:message")
	aviso("ci:run")
	aviso("chat:mention")
	var kinds []string
	for _, e := range fake.envios {
		kinds = append(kinds, e.msg.Kind)
	}
	if strings.Join(kinds, ",") != "chat:mention" {
		t.Errorf("al teléfono llegó %v; se esperaba sólo la mención (el directo está callado y el CI no va por defecto)", kinds)
	}

	prefs.PushCI = true
	svc.SavePrefs(prefs)
	aviso("ci:run")
	if len(fake.envios) != 2 || fake.envios[1].msg.Kind != "ci:run" {
		t.Errorf("con el CI pedido, tenía que llegar: %+v", fake.envios)
	}

	prefs.PushQuiet = true
	svc.SavePrefs(prefs)
	aviso("chat:mention")
	if len(fake.envios) != 2 {
		t.Errorf("con el teléfono callado llegó otro aviso")
	}
	var filas int64
	db.Model(&domain.Notification{}).Where("kind = 'chat:mention'").Count(&filas)
	if filas != 2 {
		t.Errorf("callar el teléfono no puede callar la campana: %d menciones en la campana", filas)
	}
}

// Nunca al dispositivo de otra persona, y el mismo navegador suscrito por otra
// persona pasa a ser de ésa. Mutantes: enviar a todas las suscripciones; no
// actualizar el dueño en el upsert.
func TestAPhoneOnlyGetsItsOwnersBell(t *testing.T) {
	svc, p, fake, repo, _ := montarPush(t)
	suscribir(t, p, "u-bea", "https://push.example/compartido")
	svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: "chat:mention", Title: "x", Link: "/x"})
	if len(fake.envios) != 0 {
		t.Fatalf("el aviso de Ana llegó al dispositivo de Bea: %+v", fake.envios)
	}
	// Ana entra en ese navegador y se suscribe: ahora es suyo.
	suscribir(t, p, "u-ana", "https://push.example/compartido")
	svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: "chat:mention", Title: "x", Link: "/x"})
	if len(fake.envios) != 1 {
		t.Fatalf("tras suscribirse Ana en el mismo navegador, %d envíos", len(fake.envios))
	}
	if subs, _ := repo.ForUser("u-bea"); len(subs) != 0 {
		t.Errorf("el navegador sigue siendo también de Bea: %+v", subs)
	}
	// Y Bea no puede dar de baja un dispositivo que ya no es suyo.
	p.Unsubscribe("u-bea", "https://push.example/compartido")
	if subs, _ := repo.ForUser("u-ana"); len(subs) != 1 {
		t.Errorf("Bea dio de baja el dispositivo de Ana")
	}
}

// Un dispositivo que el servicio de push da por muerto (410, 404) se olvida; uno
// que acepta queda con su hora. Mutantes: no olvidar; olvidar con cualquier
// error.
func TestADeadPhoneIsForgotten(t *testing.T) {
	svc, p, fake, repo, _ := montarPush(t)
	suscribir(t, p, "u-ana", "https://push.example/vivo")
	svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: "chat:mention", Title: "x", Link: "/x"})
	subs, _ := repo.ForUser("u-ana")
	if len(subs) != 1 || subs[0].LastOkAt == nil {
		t.Fatalf("un envío aceptado no dejó su hora: %+v", subs)
	}

	fake.status = 500
	svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: "chat:mention", Title: "x", Link: "/x"})
	if subs, _ := repo.ForUser("u-ana"); len(subs) != 1 {
		t.Fatal("un 500 del servicio de push no dice que el dispositivo murió")
	}

	fake.status = 410
	svc.Notify(domain.Aviso{UserID: "u-ana", OrgID: "org-1", Kind: "chat:mention", Title: "x", Link: "/x"})
	if subs, _ := repo.ForUser("u-ana"); len(subs) != 0 {
		t.Errorf("un 410 tenía que olvidar el dispositivo: %+v", subs)
	}
}

// El tema de Web Push tiene un formato estricto (≤ 32 de base64url). Mutantes:
// mandar la clave de grupo tal cual; recortar sin resumir (dos grupos con el
// mismo prefijo compartirían tema y uno pisaría al otro).
func TestThePushTopicFitsAndDoesNotCollide(t *testing.T) {
	a, b := pushTopic("space:11111111-2222-3333-4444-555555555555"), pushTopic("space:11111111-2222-3333-4444-666666666666")
	for _, x := range []string{a, b} {
		if len(x) > 32 || strings.ContainsAny(x, ":+/=") {
			t.Errorf("tema inválido: %q", x)
		}
	}
	if a == b {
		t.Error("dos grupos distintos con el mismo tema")
	}
	if pushTopic("") != "" {
		t.Error("sin etiqueta, sin tema")
	}
	_ = time.Second
}
