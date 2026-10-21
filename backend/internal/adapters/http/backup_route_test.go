package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

const joseKey = "age1uzcuhrh6yezjg96efqkks530nnrtmea9q89m87pawfqdckp8h9yqf9yvjy"

// fakeBackupStore apunta lo que se le pidió firmar y borrar.
type fakeBackupStore struct {
	mu       sync.Mutex
	puts     map[string]time.Time
	deleted  []string
	refuseRm map[string]bool
}

func (f *fakeBackupStore) Enabled() bool  { return true }
func (f *fakeBackupStore) Prefix() string { return "backups" }
func (f *fakeBackupStore) PresignPut(_ context.Context, key string, _ int64, _ string, until time.Time) (*domain.PresignedRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.puts == nil {
		f.puts = map[string]time.Time{}
	}
	f.puts[key] = until
	return &domain.PresignedRequest{Method: "PUT", URL: "https://s3.test/" + key, Headers: map[string]string{}}, nil
}
func (f *fakeBackupStore) PresignGet(_ context.Context, key string, _ time.Duration) (*domain.PresignedRequest, error) {
	return &domain.PresignedRequest{Method: "GET", URL: "https://s3.test/" + key}, nil
}
func (f *fakeBackupStore) DeleteAllVersions(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refuseRm[key] {
		return fmt.Errorf("object protected by object lock")
	}
	f.deleted = append(f.deleted, key)
	return nil
}

type countingInbox struct {
	mu    sync.Mutex
	kinds []string
}

func (c *countingInbox) Notify(a domain.Aviso) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.kinds = append(c.kinds, a.Kind)
}
func (c *countingInbox) count(kind string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, k := range c.kinds {
		if k == kind {
			n++
		}
	}
	return n
}

func backupDB(t *testing.T) *gorm.DB {
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
		t.Fatalf("DB_HOST is set but the database does not answer (a skipped test is not a green one): %v", err)
	}
	const name = "cac_test_backups"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Fatalf("DB_HOST is set but a throwaway database cannot be created: %v", err)
	}
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.OrgMembership{}, &domain.User{}, &domain.Server{},
		&domain.Deployable{}, &domain.Deployment{}, &domain.ImageBuild{},
		&domain.Notification{}, &domain.NotificationPrefs{},
		&domain.BackupTarget{}, &domain.Backup{}, &domain.BackupRecipient{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureDeployIndexes(db); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureBackupIndexes(db); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, s := range []string{"srv-1", "srv-2"} {
		if err := db.Exec(`INSERT INTO servers (id, org_id, name, host, ssh_port, ssh_user, type, agent_port, status, created_at, updated_at)
			VALUES (?, 'org-1', ?, '10.0.0.1', 22, 'root', 'docker-swarm', 9090, 'pending', ?, ?)`, s, "boaty-"+s, now, now).Error; err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if a, _ := admin.DB(); a != nil {
			a.Close()
		}
	})
	return db
}

// El recorrido entero de un backup por las rutas de verdad, de quien lo
// configura al agente que lo cierra (#166).
// Mutantes:
//   - programar sin llave;
//   - dejar configurar a quien no es admin;
//   - repartir backups a un agente v8;
//   - no filtrar por servidor en log/upload/finish;
//   - firmar la subida sin la retención de su clase;
//   - dejar descargar a un viewer.
func TestABackupRunsEndToEndThroughTheAgentRoutes(t *testing.T) {
	db := backupDB(t)
	fake := &fakeBackupStore{}
	prevStore, prevClock := newBackupStore, startBackupClockFn
	newBackupStore = func() service.BackupStore { return fake }
	startBackupClockFn = func(*service.BackupService) {}
	defer func() { newBackupStore, startBackupClockFn = prevStore, prevClock }()

	r := chi.NewRouter()
	InitServerRoutes(db, r, events.NewHub())
	servers := service.NewServerService(repository.NewServerRepository(db))
	tok1, _ := servers.MintAgentToken("srv-1")
	tok2, _ := servers.MintAgentToken("srv-2")

	person := func(role domain.OrgRole) string {
		pair, err := repository.GenerateTokens("u-"+string(role), string(role), false,
			[]domain.OrgMembershipClaim{{OrgID: "org-1", Role: role}})
		if err != nil {
			t.Fatal(err)
		}
		return pair.AccessToken
	}
	admin, member, viewer := person(domain.OrgRoleAdmin), person(domain.OrgRoleMember), person(domain.OrgRoleViewer)
	do := func(tok, method, path, body string, version ...string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		if len(version) > 0 {
			req.Header.Set("X-Agent-Version", version[0])
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	base := "/api/v1/servers/srv-1/backups"
	target := `{"serviceName":"sqlserver-prod_db","engine":"mssql","database":"boaty","credentialEnv":"MSSQL_SA_PASSWORD",
		"everyHours":24,"anchorTime":"03:30","timezone":"America/Mexico_City","keepDays":7,"keepWeekly":4,"keepMonthly":6,"restoreTestEveryDays":7}`

	if rec := do(admin, "POST", base+"/targets", target); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "backups-need-a-recipient") {
		t.Fatalf("sin llave → %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(viewer, "POST", base+"/recipients", `{"label":"jose","publicKey":"`+joseKey+`"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("un viewer pone la llave → %d", rec.Code)
	}
	if rec := do(admin, "POST", base+"/recipients", `{"label":"jose","publicKey":"AGE-SECRET-KEY-1X"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("una llave privada como pública → %d", rec.Code)
	}
	if rec := do(admin, "POST", base+"/recipients", `{"label":"jose","publicKey":"`+joseKey+`"}`); rec.Code != http.StatusCreated {
		t.Fatalf("la llave → %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(member, "POST", base+"/targets", target); rec.Code != http.StatusForbidden {
		t.Fatalf("un miembro configura → %d", rec.Code)
	}
	rec := do(admin, "POST", base+"/targets", target)
	if rec.Code != http.StatusCreated {
		t.Fatalf("la base → %d %s", rec.Code, rec.Body.String())
	}
	var created struct{ Data domain.BackupTarget }
	json.Unmarshal(rec.Body.Bytes(), &created)
	if created.Data.NextRunAt == nil {
		t.Fatal("sin siguiente")
	}
	tid := created.Data.ID
	if rec := do(admin, "POST", base+"/targets/"+tid+"/run", ""); rec.Code != http.StatusAccepted {
		t.Fatalf("backup ahora → %d %s", rec.Code, rec.Body.String())
	}

	poll := "/agent/v1/jobs?wait=0"
	if rec := do(tok1.Token, "GET", poll, "", "8"); rec.Code != http.StatusNoContent {
		t.Fatalf("un agente v8 recibió algo → %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(tok2.Token, "GET", poll, "", "9"); rec.Code != http.StatusNoContent {
		t.Fatalf("el agente de otro servidor recibió algo → %d", rec.Code)
	}
	rec = do(tok1.Token, "GET", poll, "", "9")
	if rec.Code != http.StatusOK {
		t.Fatalf("el agente v9 → %d %s", rec.Code, rec.Body.String())
	}
	var job struct {
		ID, Kind string
		Data     domain.BackupJob
	}
	json.Unmarshal(rec.Body.Bytes(), &job)
	if job.Kind != "backup" || job.Data.CredentialEnv != "MSSQL_SA_PASSWORD" || len(job.Data.Recipients) != 1 || job.Data.Recipients[0] != joseKey {
		t.Fatalf("el trabajo: %+v", job)
	}

	agentPath := "/agent/v1/backups/" + job.ID
	upload := `{"sizeBytes":60616704,"sha256":"` + strings.Repeat("ab", 32) + `"}`
	for _, c := range []struct{ path, body string }{
		{agentPath + "/log", `{"lines":["x"]}`},
		{agentPath + "/upload-url", upload},
		{agentPath + "/finish", `{"status":"succeeded"}`},
	} {
		if rec := do(tok2.Token, "POST", c.path, c.body, "9"); rec.Code != http.StatusConflict {
			t.Errorf("otro servidor en %s → %d", c.path, rec.Code)
		}
	}
	if rec := do(tok1.Token, "POST", agentPath+"/log", `{"lines":["BACKUP DATABASE successfully processed"]}`, "9"); rec.Code != http.StatusNoContent {
		t.Fatalf("el log → %d", rec.Code)
	}
	before := time.Now()
	if rec := do(tok1.Token, "POST", agentPath+"/upload-url", upload, "9"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "https://s3.test/backups/org-1/srv-1/"+tid+"/") {
		t.Fatalf("la URL de subida → %d %s", rec.Code, rec.Body.String())
	}
	// El primero de todos es mensual: 6×31 días.
	for _, until := range fake.puts {
		want := before.Add(6 * 31 * 24 * time.Hour)
		if d := until.Sub(want); d < -time.Minute || d > time.Minute {
			t.Errorf("la retención firmada: %s, se esperaba ~%s", until, want)
		}
	}
	if rec := do(tok1.Token, "POST", agentPath+"/finish", `{"status":"succeeded"}`, "9"); rec.Code != http.StatusNoContent {
		t.Fatalf("el cierre → %d %s", rec.Code, rec.Body.String())
	}

	rec = do(viewer, "GET", base+"/targets/"+tid+"/history", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"succeeded"`) || !strings.Contains(rec.Body.String(), `"retentionClass":"monthly"`) {
		t.Fatalf("el historial → %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(viewer, "POST", base+"/runs/"+job.ID+"/download", ""); rec.Code != http.StatusForbidden {
		t.Errorf("un viewer descarga → %d", rec.Code)
	}
	if rec := do(admin, "POST", base+"/runs/"+job.ID+"/download", ""); rec.Code != http.StatusOK {
		t.Errorf("un admin descarga → %d %s", rec.Code, rec.Body.String())
	}
	var tg domain.BackupTarget
	db.First(&tg, "id = ?", tid)
	if tg.LastSuccessAt == nil {
		t.Error("la base no apuntó el backup bueno")
	}
}

func backupFixture(t *testing.T, db *gorm.DB, fake *fakeBackupStore, inbox *countingInbox) (*service.BackupService, *domain.BackupTarget) {
	t.Helper()
	repo := repository.NewBackupRepository(db)
	if err := db.Exec(`INSERT INTO org_memberships (org_id, user_id, role) VALUES ('org-1','u-admin','admin')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.AddRecipient(&domain.BackupRecipient{OrgID: "org-1", Label: "jose", PublicKey: joseKey}); err != nil {
		t.Fatal(err)
	}
	svc := service.NewBackupService(repo, repository.NewServerRepository(db), repository.NewOrganizationRepository(db), fake, nil, inbox)
	tg, err := svc.CreateTarget(&domain.ServerResponse{ID: "srv-1", OrgID: "org-1"}, domain.BackupTargetRequest{
		ServiceName: "db", Engine: "postgres", Database: "app", CredentialEnv: "POSTGRES_USER",
		EveryHours: 24, AnchorTime: "03:30", Timezone: "UTC", KeepDays: 7, KeepWeekly: 4, KeepMonthly: 6,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc, tg
}

// El reloj encola una sola vez aunque corra en dos réplicas, y el aviso de
// «sin backup» sale una vez por racha y se rearma con el siguiente bueno.
// Mutantes: encolar sin el compare-and-swap; avisar en cada vuelta; no
// rearmar.
func TestTheBackupClockEnqueuesOnceAndWarnsOnce(t *testing.T) {
	db := backupDB(t)
	inbox := &countingInbox{}
	svc, tg := backupFixture(t, db, &fakeBackupStore{}, inbox)
	due := tg.NextRunAt.Add(time.Minute)

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); svc.FireDue(due) }()
	}
	wg.Wait()
	var n int64
	db.Model(&domain.Backup{}).Where("target_id = ?", tg.ID).Count(&n)
	if n != 1 {
		t.Fatalf("dos relojes encolaron %d", n)
	}

	// Tres días sin un bueno: avisa una vez, aunque el reloj dé más vueltas.
	db.Exec("DELETE FROM backups")
	db.Exec("UPDATE backup_targets SET created_at = ?, next_run_at = ? WHERE id = ?", due.Add(-72*time.Hour), due.Add(time.Hour), tg.ID)
	svc.FireDue(due)
	svc.FireDue(due.Add(time.Minute))
	if got := inbox.count("backup:stale"); got != 1 {
		t.Fatalf("avisos de «sin backup»: %d, se esperaba 1", got)
	}
	// Un bueno lo rearma: la siguiente racha vuelve a avisar.
	b := &domain.Backup{OrgID: "org-1", ServerID: "srv-1", TargetID: tg.ID, Kind: domain.BackupKindManual, Status: domain.BackupRunning, ObjectKey: "k"}
	db.Create(b)
	if err := svc.Finish("srv-1", b.ID, domain.AgentBackupFinishRequest{Status: domain.BackupSucceeded}); err != nil {
		t.Fatal(err)
	}
	svc.FireDue(due.Add(72 * time.Hour))
	if got := inbox.count("backup:stale"); got != 2 {
		t.Fatalf("tras un bueno y otra racha: %d avisos, se esperaban 2", got)
	}
}

// El conserje sólo borra lo vencido, y lo que S3 se niega a borrar se queda
// para otro día. Mutantes: borrar por antigüedad sin mirar `RetainUntil`;
// marcar como borrado lo que S3 rechazó.
func TestThePurgeKeepsWhatIsStillLocked(t *testing.T) {
	db := backupDB(t)
	fake := &fakeBackupStore{refuseRm: map[string]bool{"stubborn": true}}
	svc, tg := backupFixture(t, db, fake, &countingInbox{})
	now := time.Now()
	past, future := now.Add(-time.Hour), now.Add(24*time.Hour)
	for key, until := range map[string]time.Time{"old": past, "young": future, "stubborn": past} {
		u := until
		db.Create(&domain.Backup{OrgID: "org-1", ServerID: "srv-1", TargetID: tg.ID, Kind: domain.BackupKindScheduled,
			Status: domain.BackupSucceeded, ObjectKey: key, RetainUntil: &u, BaseModel: domain.BaseModel{CreatedAt: now.Add(-400 * 24 * time.Hour)}})
	}
	n, err := svc.Purge(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(fake.deleted) != 1 || fake.deleted[0] != "old" {
		t.Fatalf("borró %d: %v", n, fake.deleted)
	}
	var stubborn domain.Backup
	db.First(&stubborn, "object_key = ?", "stubborn")
	if stubborn.PurgedAt != nil {
		t.Error("marcó como borrado lo que S3 se negó a borrar")
	}
}

// Las dos reservas del reloj son compare-and-swap: de dos réplicas que vieron
// lo mismo, sólo una gana. El índice de un solo vivo por base tapa el doble
// encolado, pero no el doble aviso ni el doble salto de hora, así que se
// prueban aquí y no a través de FireDue.
// Mutantes: reservar la hora sin comparar la vista; apuntar el aviso sin
// mirar si ya estaba.
func TestTheClockReservationsHaveOneWinner(t *testing.T) {
	db := backupDB(t)
	_, tg := backupFixture(t, db, &fakeBackupStore{}, &countingInbox{})
	repo := repository.NewBackupRepository(db)
	seen, next := *tg.NextRunAt, tg.NextRunAt.Add(24*time.Hour)
	if won, err := repo.ReserveRun(tg.ID, seen, next); err != nil || !won {
		t.Fatalf("la primera reserva: %v %v", won, err)
	}
	if won, _ := repo.ReserveRun(tg.ID, seen, next.Add(24*time.Hour)); won {
		t.Error("la segunda réplica también reservó la misma hora")
	}
	now := time.Now()
	if won, _ := repo.MarkStaleNotified(tg.ID, now); !won {
		t.Fatal("el primer aviso no se apuntó")
	}
	if won, _ := repo.MarkStaleNotified(tg.ID, now); won {
		t.Error("el aviso se apuntó dos veces")
	}
}
