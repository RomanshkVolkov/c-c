package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Pedir la entrada a una sala de voz ajena.

El token de voz es la puerta: quien lo tiene entra y habla. Que la sala se
derive del espacio en el servidor sirve de poco si cualquiera puede pedir el
token de cualquier espacio — la comprobación de pertenencia es lo que hace que
la puerta signifique algo, y vive en el handler.

Se prueba aquí y no en el servicio porque el servicio acuña obedientemente lo
que se le pide: decidir **si se le puede pedir** es trabajo de esta capa, y una
mutación que quite el guard pasa todos los tests del servicio.
*/

func voiceReq(spaceID string, claims *domain.ClaimsJWT) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/task-spaces/"+spaceID+"/voice/token", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", spaceID)
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, repository.UserContextKey, claims)
	return r.WithContext(ctx)
}

func voiceHandler(db *gorm.DB, voz *service.VoiceService) *taskHandler {
	svc := service.NewTaskService(
		repository.NewTaskRepository(db),
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		nil,
	)
	return &taskHandler{svc: svc, voice: voz}
}

func TestNoSePuedeEntrarAlaVozDeOtraOrganizacion(t *testing.T) {
	db, cleanup := voiceDB(t)
	defer cleanup()
	h := voiceHandler(db, service.NewVoiceService("wss://rtc.example", "APIabc", "un-secreto-largo-de-prueba"))

	// Ana pertenece a org-1 y pide la sala de un espacio de org-2.
	ajena := &domain.ClaimsJWT{
		UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}},
	}
	rec := httptest.NewRecorder()
	h.VoiceToken(rec, voiceReq("esp-ajeno", ajena))

	// 404 y no 403: confirmar que el espacio existe ya sería contar algo.
	if rec.Code != http.StatusNotFound {
		t.Errorf("pedir la voz de otra organización → %d, se esperaba 404", rec.Code)
	}
	if body := rec.Body.String(); len(body) > 0 && contiene(body, "token") {
		t.Error("no puede haber ni rastro de un token en la respuesta")
	}
}

func TestUnMiembroRecibeSuTokenParaLaSalaDeSuEspacio(t *testing.T) {
	db, cleanup := voiceDB(t)
	defer cleanup()
	h := voiceHandler(db, service.NewVoiceService("wss://rtc.example", "APIabc", "un-secreto-largo-de-prueba"))

	suya := &domain.ClaimsJWT{
		UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}},
	}
	rec := httptest.NewRecorder()
	h.VoiceToken(rec, voiceReq("esp-1", suya))

	if rec.Code != http.StatusOK {
		t.Fatalf("un miembro tiene que poder entrar → %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Data domain.VoiceTokenResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Data.Room != "voice:esp-1" {
		t.Errorf("la sala sale del espacio; salió %q", res.Data.Room)
	}
	if res.Data.Token == "" || res.Data.URL == "" {
		t.Error("sin token o sin url no hay a dónde ir")
	}
}

// Sin SFU configurado se dice, no se finge. Un token que ningún servidor va a
// aceptar es peor que un «esto no está montado».
func TestSinVozConfiguradaSeDiceQueNoLaHay(t *testing.T) {
	db, cleanup := voiceDB(t)
	defer cleanup()
	h := voiceHandler(db, service.NewVoiceService("", "", ""))

	suya := &domain.ClaimsJWT{
		UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}},
	}
	rec := httptest.NewRecorder()
	h.VoiceToken(rec, voiceReq("esp-1", suya))

	if rec.Code != http.StatusNotImplemented {
		t.Errorf("sin voz configurada → %d, se esperaba 501", rec.Code)
	}
}

func contiene(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func voiceDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_voice_token"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.TaskSpace{}); err != nil {
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
		VALUES ('esp-1','org-1','Nuestro','#fff','m',?,?), ('esp-ajeno','org-2','De otro cliente','#fff','m',?,?)`,
		ahora, ahora, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
