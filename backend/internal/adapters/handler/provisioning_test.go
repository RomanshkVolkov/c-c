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
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Un servidor por su id, y lo que se le aplicó.

Las dos rutas son de la rebanada R0 del módulo de servidores. `GET /servers/{id}`
existe para que las páginas de un servidor dejen de vivir del `state` del router
(que no sobrevive a recargar), y el registro de provisioning para que «alguien
corrió un playbook contra esta máquina» deje rastro.

Lo que se fija aquí es quién puede qué: a quien no es de la org, 404 (ni
siquiera se confirma que existe); ver, cualquiera de la org; lanzar y cerrar,
quien puede escribir. Y que una ejecución se cierra una sola vez, y sólo desde
su propio servidor.
*/

func TestGetServerAnswersOnlyToItsOrganization(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := NewServerHandler(service.NewServerService(repository.NewServerRepository(db)))

	get := func(claims *domain.ClaimsJWT) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.GetServer(rec, serverReq(http.MethodGet, "srv-1", "", "", claims))
		return rec
	}

	// De otra org: 404, igual que un id que no existe.
	if rec := get(claims("u-ajena", "org-2", domain.OrgRoleAdmin)); rec.Code != http.StatusNotFound {
		t.Errorf("alguien de otra org → %d, se esperaba 404", rec.Code)
	}
	// Un viewer de la org, sí.
	rec := get(claims("u-vera", "org-1", domain.OrgRoleViewer))
	if rec.Code != http.StatusOK {
		t.Fatalf("un viewer de la org → %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Data domain.ServerResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Data.ID != "srv-1" || res.Data.Host != "10.0.0.1" {
		t.Errorf("devolvió otra cosa: %+v", res.Data)
	}
	// Y el superadmin, aunque no sea miembro.
	root := &domain.ClaimsJWT{UserID: "u-root", Username: "root", Superadmin: true}
	if rec := get(root); rec.Code != http.StatusOK {
		t.Errorf("un superadmin → %d", rec.Code)
	}
}

func TestOnlyWritersStartAndFinishRuns(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := provisioningHandler(db)

	cuerpo := `{"kind":"playbook","project":"ansible-swarm","playbook":"config-tds-rrhh","target":"tds-rh","varNames":["deploy_public_key"]}`

	rec := httptest.NewRecorder()
	h.Start(rec, serverReq(http.MethodPost, "srv-1", "", cuerpo, claims("u-vera", "org-1", domain.OrgRoleViewer)))
	if rec.Code != http.StatusForbidden {
		t.Errorf("un viewer lanzando un playbook → %d, se esperaba 403", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.Start(rec, serverReq(http.MethodPost, "srv-1", "", cuerpo, claims("u-ana", "org-1", domain.OrgRoleMember)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("un miembro lanzando un playbook → %d: %s", rec.Code, rec.Body.String())
	}

	// El viewer sí lo ve, con el nombre de quien lo lanzó y no su usuario.
	rec = httptest.NewRecorder()
	h.List(rec, serverReq(http.MethodGet, "srv-1", "", "", claims("u-vera", "org-1", domain.OrgRoleViewer)))
	var lista struct {
		Data []domain.ProvisioningRunResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &lista); err != nil {
		t.Fatal(err)
	}
	if len(lista.Data) != 1 {
		t.Fatalf("se esperaba una ejecución, hay %d", len(lista.Data))
	}
	run := lista.Data[0]
	if run.StartedByName != "Ana López" {
		t.Errorf("el nombre de quien la lanzó es %q, se esperaba «Ana López»", run.StartedByName)
	}
	if run.VarNames != "deploy_public_key" || run.Status != domain.ProvisioningRunning {
		t.Errorf("la ejecución no quedó como se abrió: %+v", run.ProvisioningRun)
	}
}

func TestARunIsClosedOnceAndOnlyFromItsServer(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := provisioningHandler(db)
	ana := claims("u-ana", "org-1", domain.OrgRoleMember)

	rec := httptest.NewRecorder()
	h.Start(rec, serverReq(http.MethodPost, "srv-1", "", `{"kind":"playbook","playbook":"test"}`, ana))
	var abierta struct {
		Data domain.ProvisioningRun `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &abierta); err != nil {
		t.Fatal(err)
	}
	id := abierta.Data.ID

	fin := `{"status":"succeeded","exitCode":0,"summary":"tds-rh : ok=12 changed=3","logTail":"PLAY RECAP"}`

	// Cerrarla desde otro servidor de la misma org no la toca.
	rec = httptest.NewRecorder()
	h.Finish(rec, serverReq(http.MethodPatch, "srv-2", id, fin, ana))
	if rec.Code != http.StatusConflict {
		t.Errorf("cerrar desde otro servidor → %d, se esperaba 409", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.Finish(rec, serverReq(http.MethodPatch, "srv-1", id, fin, ana))
	if rec.Code != http.StatusOK {
		t.Fatalf("cerrarla → %d: %s", rec.Code, rec.Body.String())
	}

	// Y un segundo cierre no reescribe cómo acabó.
	rec = httptest.NewRecorder()
	h.Finish(rec, serverReq(http.MethodPatch, "srv-1", id, `{"status":"failed","exitCode":2}`, ana))
	if rec.Code != http.StatusConflict {
		t.Errorf("cerrarla dos veces → %d, se esperaba 409", rec.Code)
	}

	var guardada domain.ProvisioningRun
	if err := db.First(&guardada, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if guardada.Status != domain.ProvisioningSucceeded || guardada.ExitCode == nil || *guardada.ExitCode != 0 {
		t.Errorf("quedó %s / %v, se esperaba succeeded / 0", guardada.Status, guardada.ExitCode)
	}
	if guardada.FinishedAt == nil {
		t.Error("cerrada sin hora de fin")
	}
}

// ─── Montaje ──────────────────────────────────────────────────────────────────

func provisioningHandler(db *gorm.DB) *ProvisioningHandler {
	return NewProvisioningHandler(
		service.NewServerService(repository.NewServerRepository(db)),
		service.NewProvisioningService(repository.NewProvisioningRepository(db)),
	)
}

func claims(userID, orgID string, role domain.OrgRole) *domain.ClaimsJWT {
	return &domain.ClaimsJWT{
		UserID: userID, Username: userID,
		Orgs: []domain.OrgMembershipClaim{{OrgID: orgID, Role: role}},
	}
}

func serverReq(method, serverID, runID, body string, c *domain.ClaimsJWT) *http.Request {
	r := httptest.NewRequest(method, "/api/v1/servers/"+serverID, strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", serverID)
	if runID != "" {
		rctx.URLParams.Add("rid", runID)
	}
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, repository.UserContextKey, c)
	return r.WithContext(ctx)
}

func provisioningDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_provisioning"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.User{}, &domain.Server{}, &domain.ProvisioningRun{}); err != nil {
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
	must(db.Exec(`INSERT INTO users (id, username, name, password, created_at, updated_at)
		VALUES ('u-ana','ana','Ana López','x',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO servers (id, org_id, name, host, ssh_port, ssh_user, type, agent_port, status, created_at, updated_at)
		VALUES ('srv-1','org-1','tds','10.0.0.1',22,'root','docker-swarm',9090,'pending',?,?),
		       ('srv-2','org-1','otro','10.0.0.2',22,'root','docker-swarm',9090,'pending',?,?),
		       ('srv-k8s','org-1','clúster','10.0.0.3',22,'root','kubernetes',9090,'pending',?,?)`,
		ahora, ahora, ahora, ahora, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
