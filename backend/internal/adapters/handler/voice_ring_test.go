package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
El timbre: hacer sonar el escritorio de una persona.

Dos cosas pueden salir mal aquí y las dos son ruidosas. La primera es llamar a
quien no se puede: sin el guard, esto es un pulsador para hacer sonar el
escritorio de cualquiera cuyo id se conozca, incluido el de otro cliente. La
segunda es más silenciosa y peor de vivir: si el aviso sale dirigido a la
organización en vez de a la persona, **suena en todos los escritorios del
equipo** y nadie sabe a quién llamaban. El segundo test es el que lo vigila.
*/

func ringReq(spaceID, cuerpo string, claims *domain.ClaimsJWT) *http.Request {
	r := httptest.NewRequest(http.MethodPost,
		"/api/v1/task-spaces/"+spaceID+"/voice/ring", strings.NewReader(cuerpo))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", spaceID)
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, repository.UserContextKey, claims)
	return r.WithContext(ctx)
}

func cancelReq(spaceID, userID string, claims *domain.ClaimsJWT) *http.Request {
	r := httptest.NewRequest(http.MethodDelete,
		"/api/v1/task-spaces/"+spaceID+"/voice/ring/"+userID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", spaceID)
	rctx.URLParams.Add("userId", userID)
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, repository.UserContextKey, claims)
	return r.WithContext(ctx)
}

func ringHandler(db *gorm.DB, hub *events.Hub) *taskHandler {
	svc := service.NewTaskService(
		repository.NewTaskRepository(db),
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		hub,
	)
	return &taskHandler{svc: svc}
}

// ana y bea son de org-1; carla es de org-2.
func ana() *domain.ClaimsJWT {
	return &domain.ClaimsJWT{UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}}}
}

// espera lee del canal con un plazo: un timbre que no llega nunca no debe
// colgar la suite, y un `select` con timeout dice «no llegó» en vez de morir.
func espera(t *testing.T, ch <-chan events.Event) *events.Event {
	t.Helper()
	select {
	case e := <-ch:
		return &e
	case <-time.After(time.Second):
		return nil
	}
}

func TestNoSePuedeTimbrarAQuienNoEstaEnLaOrganizacion(t *testing.T) {
	db, cleanup := ringDB(t)
	defer cleanup()
	hub := events.NewHub()
	h := ringHandler(db, hub)

	// Carla existe, y está en otra organización. Su id es lo único que hace
	// falta saber para molestarla si nadie comprueba nada.
	deCarla, _ := hub.Subscribe("u-carla", []string{"org-2"})

	rec := httptest.NewRecorder()
	h.VoiceRing(rec, ringReq("esp-1", `{"userId":"u-carla"}`, ana()))

	if rec.Code != http.StatusForbidden {
		t.Errorf("timbrar a alguien de otra organización → %d, se esperaba 403", rec.Code)
	}
	if e := espera(t, deCarla); e != nil {
		t.Errorf("y sobre todo: no le puede sonar el teléfono, y sonó (%s)", e.Type)
	}
}

func TestElTimbreSuenaEnUnSoloEscritorio(t *testing.T) {
	db, cleanup := ringDB(t)
	defer cleanup()
	hub := events.NewHub()
	h := ringHandler(db, hub)

	deBea, _ := hub.Subscribe("u-bea", []string{"org-1"})
	// Dani también es de org-1 y no tiene nada que ver con esta llamada.
	deDani, _ := hub.Subscribe("u-dani", []string{"org-1"})

	rec := httptest.NewRecorder()
	h.VoiceRing(rec, ringReq("esp-1", `{"userId":"u-bea"}`, ana()))
	if rec.Code != http.StatusOK {
		t.Fatalf("timbrar a una compañera → %d: %s", rec.Code, rec.Body.String())
	}

	e := espera(t, deBea)
	if e == nil {
		t.Fatal("a quien llamas tiene que sonarle el teléfono")
	}
	if e.Type != "voice.ring" {
		t.Errorf("tipo %q, se esperaba voice.ring", e.Type)
	}
	// Y a nadie más. Un timbre org-wide suena en todo el equipo y nadie sabe a
	// quién llamaban — el fallo que este test existe para impedir.
	if otro := espera(t, deDani); otro != nil {
		t.Errorf("le sonó también a quien no llamaban (%s)", otro.Type)
	}

	timbre, ok := e.Data.(*domain.VoiceRing)
	if !ok {
		t.Fatalf("el evento no lleva un timbre sino %T", e.Data)
	}
	if timbre.From.ID != "u-ana" || timbre.SpaceID != "esp-1" {
		t.Errorf("el timbre tiene que decir quién llama y a qué sala: %+v", timbre)
	}
	// Sin tope, un timbre que nadie recoge suena hasta que se cierra la app.
	if falta := time.Until(timbre.ExpiresAt); falta <= 0 || falta > service.TimbreTTL {
		t.Errorf("el timbre caduca en %s, y debe caducar dentro de %s", falta, service.TimbreTTL)
	}

	var res struct {
		Data domain.VoiceRing `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Data.RingID == "" {
		t.Error("quien llama necesita el id para poder colgar")
	}
}

func TestColgarCallaElTelefonoDeQuienNoContesto(t *testing.T) {
	db, cleanup := ringDB(t)
	defer cleanup()
	hub := events.NewHub()
	h := ringHandler(db, hub)
	deBea, _ := hub.Subscribe("u-bea", []string{"org-1"})

	h.VoiceRing(httptest.NewRecorder(), ringReq("esp-1", `{"userId":"u-bea"}`, ana()))
	espera(t, deBea) // el timbre

	rec := httptest.NewRecorder()
	h.VoiceRingCancel(rec, cancelReq("esp-1", "u-bea", ana()))
	if rec.Code != http.StatusOK {
		t.Fatalf("colgar → %d: %s", rec.Code, rec.Body.String())
	}

	e := espera(t, deBea)
	if e == nil || e.Type != "voice.ring.cancel" {
		t.Fatalf("colgar tiene que llegar al otro lado, y llegó %v", e)
	}
	// Lleva quién colgaba: si no, un timbre de otra persona en curso se
	// apagaría con el mismo evento.
	if c, ok := e.Data.(*domain.VoiceRingCancel); !ok || c.From != "u-ana" {
		t.Errorf("la cancelación tiene que decir de quién es: %+v", e.Data)
	}
}

func TestTimbrarseAUnoMismoNoHaceSonarNada(t *testing.T) {
	db, cleanup := ringDB(t)
	defer cleanup()
	hub := events.NewHub()
	h := ringHandler(db, hub)
	deAna, _ := hub.Subscribe("u-ana", []string{"org-1"})

	rec := httptest.NewRecorder()
	h.VoiceRing(rec, ringReq("esp-1", `{"userId":"u-ana"}`, ana()))

	if rec.Code != http.StatusForbidden {
		t.Errorf("llamarse a uno mismo → %d, se esperaba 403", rec.Code)
	}
	// Sonaría en el mismo escritorio desde el que se pulsó, encima de la sala
	// en la que ya estás.
	if e := espera(t, deAna); e != nil {
		t.Errorf("y no puede sonarte a ti (%s)", e.Type)
	}
}

func ringDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_voice_ring"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	// Registrada antes de tocar nada: si la fixture revienta a media carga, un
	// `defer` del llamador que aún no existe no borra nada, la base se queda en
	// pie y todos los tests siguientes se saltan en silencio porque «ya existe».
	t.Cleanup(func() {
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&domain.Organization{}, &domain.TaskSpace{}, &domain.OrgMembership{},
	); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	must := func(tx *gorm.DB) {
		t.Helper()
		if tx.Error != nil {
			t.Fatalf("la fixture no se pudo insertar: %v", tx.Error)
		}
	}
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
		VALUES ('org-1','Uno','uno',?,?), ('org-2','Dos','dos',?,?)`, ahora, ahora, ahora, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-1','org-1','Nuestro','#fff','m',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		VALUES ('org-1','u-ana','member',?),
		       ('org-1','u-bea','member',?),
		       ('org-1','u-dani','member',?),
		       ('org-2','u-carla','member',?)`, ahora, ahora, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
	}
}
