package http

import (
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
	InitServerRoutes(db, r)
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
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("la pregunta sin trabajo → %d, se esperaba 204: %s", rec.Code, rec.Body.String())
	}
	if got := estado(); got != "online" {
		t.Errorf("después de preguntar: %s, se esperaba online", got)
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
	InitServerRoutes(db, r)
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
	if err := db.AutoMigrate(&domain.Organization{}, &domain.Server{}); err != nil {
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
