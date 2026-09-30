package http

import (
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
La puerta del agente, montada como en producción (`InitServerRoutes`).

Aquí y no en `handler` porque lo que se prueba es la puerta entera: que la
ruta existe, que el middleware está puesto delante, y que preguntar deja el
servidor en línea. Una prueba del handler solo no vería que alguien montó
`/agent/v1/jobs` sin el middleware.
*/

// Preguntar es el latido; callarse lo deja offline, y un token recién acuñado
// que nunca preguntó está pending.
func TestPollMarksOnlineAndSilenceMarksOffline(t *testing.T) {
	db, cleanup := agentDB(t)
	defer cleanup()
	r := chi.NewRouter()
	InitServerRoutes(db, r, events.NewHub())
	svc := service.NewServerService(repository.NewServerRepository(db))

	tok, err := svc.MintAgentToken("srv-1")
	if err != nil {
		t.Fatal(err)
	}
	estado := func() string {
		s, err := svc.Find("srv-1")
		if err != nil {
			t.Fatal(err)
		}
		return s.Status
	}
	if got := estado(); got != "pending" {
		t.Errorf("recién acuñado y sin preguntar: %s, se esperaba pending", got)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/agent/v1/jobs?wait=0", nil)
	req.Header.Set("Authorization", "Bearer "+tok.Token)
	req.Header.Set("X-Agent-Version", "5")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("la pregunta sin trabajo → %d, se esperaba 204: %s", rec.Code, rec.Body.String())
	}
	if got := estado(); got != "online" {
		t.Errorf("después de preguntar: %s, se esperaba online", got)
	}
	// Y la versión que dijo, la que quede apuntada.
	if s, _ := svc.Find("srv-1"); s.AgentVersion != 5 {
		t.Errorf("el agente dijo la versión 5 y quedó %d", s.AgentVersion)
	}

	// Dos minutos de silencio.
	hace := time.Now().Add(-2 * time.Minute)
	if err := db.Exec("UPDATE servers SET agent_seen_at = ? WHERE id = 'srv-1'", hace).Error; err != nil {
		t.Fatal(err)
	}
	if got := estado(); got != "offline" {
		t.Errorf("tras dos minutos sin preguntar: %s, se esperaba offline", got)
	}
}

// Sin token, o con uno que no es de agente, la puerta no se abre.
func TestTheAgentDoorWantsAnAgentToken(t *testing.T) {
	db, cleanup := agentDB(t)
	defer cleanup()
	r := chi.NewRouter()
	InitServerRoutes(db, r, events.NewHub())
	svc := service.NewServerService(repository.NewServerRepository(db))
	if _, err := svc.MintAgentToken("srv-1"); err != nil {
		t.Fatal(err)
	}

	for _, h := range []string{"", "Bearer ", "Bearer cac_pat_abc", "Bearer cac_agent_inventado"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/agent/v1/jobs?wait=0", nil)
		if h != "" {
			req.Header.Set("Authorization", h)
		}
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%q → %d, se esperaba 401", h, rec.Code)
		}
	}
	if got, _ := svc.Find("srv-1"); got.Status != "pending" {
		t.Errorf("un intento fallido cambió el estado a %s", got.Status)
	}
}

// El recorrido entero de un deploy por las rutas de verdad: se encola, el
// agente lo recoge en su pregunta, cuenta por dónde va y dice cómo acabó.
func TestTheAgentPollHandsOverAQueuedDeploy(t *testing.T) {
	db, cleanup := agentDB(t)
	defer cleanup()
	r := chi.NewRouter()
	InitServerRoutes(db, r, events.NewHub())
	servers := service.NewServerService(repository.NewServerRepository(db))
	deploys := service.NewDeployService(repository.NewDeployRepository(db), repository.NewServerRepository(db), nil)

	tok, err := servers.MintAgentToken("srv-1")
	if err != nil {
		t.Fatal(err)
	}
	// El agente dice su versión en cada pregunta: ésa es la que cuenta.
	if err := servers.Heartbeat("srv-1", domain.AgentVersionDeploys, time.Now()); err != nil {
		t.Fatal(err)
	}
	srv, _ := servers.Find("srv-1")
	d, err := deploys.CreateDeployable(srv, domain.CreateDeployableRequest{
		Name: "api", Stack: "api", ServiceName: "api_app", ImageRepo: "ghcr.io/a/api",
	})
	if err != nil {
		t.Fatal(err)
	}
	dep, _, err := deploys.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	if err != nil {
		t.Fatal(err)
	}

	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok.Token)
		req.Header.Set("X-Agent-Version", "3")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	rec := do(http.MethodGet, "/agent/v1/jobs?wait=0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("con un deploy en cola, la pregunta → %d: %s", rec.Code, rec.Body.String())
	}
	var job domain.AgentJob
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.ID != dep.ID || job.Kind != "deploy" || job.Data.Image != "ghcr.io/a/api:abc1234" || job.Data.ServiceName != "api_app" {
		t.Fatalf("el trabajo no es el deploy encolado: %+v", job)
	}

	if rec := do(http.MethodPost, "/agent/v1/jobs/"+job.ID+"/log", `{"lines":["bajando la imagen"]}`); rec.Code != http.StatusNoContent {
		t.Fatalf("el log → %d: %s", rec.Code, rec.Body.String())
	}
	fin := `{"status":"succeeded","previousImage":"ghcr.io/a/api:viejo","finalImage":"ghcr.io/a/api:abc1234"}`
	if rec := do(http.MethodPost, "/agent/v1/jobs/"+job.ID+"/finish", fin); rec.Code != http.StatusNoContent {
		t.Fatalf("el cierre → %d: %s", rec.Code, rec.Body.String())
	}

	got, err := deploys.FindDeployment(d.ID, dep.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.DeploySucceeded || !strings.Contains(got.Log, "bajando la imagen") {
		t.Errorf("quedó %s con log %q", got.Status, got.Log)
	}
	// Y ya no hay nada más que recoger.
	if rec := do(http.MethodGet, "/agent/v1/jobs?wait=0", ""); rec.Code != http.StatusNoContent {
		t.Errorf("sin nada en cola, la pregunta → %d", rec.Code)
	}
	// La versión que dijo en la cabecera quedó guardada.
	if s, _ := servers.Find("srv-1"); s.AgentVersion != 3 {
		t.Errorf("la versión del agente quedó en %d, dijo 3", s.AgentVersion)
	}
}

func agentDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_agent_route"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.Server{}, &domain.Deployable{}, &domain.Deployment{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureDeployIndexes(db); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	if err := db.Exec(`INSERT INTO servers (id, org_id, name, host, ssh_port, ssh_user, type, agent_port, status, created_at, updated_at)
		VALUES ('srv-1','org-1','tds','10.0.0.1',22,'root','docker-swarm',9090,'pending',?,?)`, ahora, ahora).Error; err != nil {
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
