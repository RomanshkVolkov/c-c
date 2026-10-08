package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// La telemetría contra Postgres de verdad: la fila por dispositivo, la
// búsqueda, el cursor, la retención por proyecto y el relleno de los lotes
// viejos. Hasta aquí no había ni una prueba de nada de esto.

func telemetryDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_telemetry"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.ReportProject{}, &domain.TelemetryEvent{}, &domain.TelemetryDevice{}); err != nil {
		t.Fatal(err)
	}
	// Una llave de prueba: sin ella la telemetría no se guarda.
	t.Setenv("REPORTS_KEK", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

func newProject(t *testing.T, db *gorm.DB, id, org string, cfg domain.TelemetryConfig) *domain.ReportProject {
	t.Helper()
	p := &domain.ReportProject{BaseModel: domain.BaseModel{ID: id}, OrgID: org, Name: "P " + id, Slug: id,
		IngestKeyHash: []byte(id), IsActive: true, TelemetryConfig: cfg}
	if err := db.Create(p).Error; err != nil {
		t.Fatal(err)
	}
	return p
}

func batch(device, version, deviceJSON string, crumbs ...string) domain.IngestEventBatch {
	b := domain.IngestEventBatch{DeviceID: device, SessionID: "s1", Platform: "android", AppVersion: version}
	if deviceJSON != "" {
		b.Device = json.RawMessage(deviceJSON)
	}
	for _, c := range crumbs {
		b.Breadcrumbs = append(b.Breadcrumbs, json.RawMessage(c))
	}
	return b
}

func TestTheDeviceRowKeepsTheLatestStateAndNeverAnEmail(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	repo := repository.NewTelemetryRepository(db)
	projects := repository.NewReportProjectRepository(db)
	svc := NewTelemetryService(repo, projects)
	p := newProject(t, db, "p1", "o1", domain.TelemetryConfig{})
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(svc.Ingest(p, batch("d1", "1.9", `{"label":"Pixel 8","subject":"ana@empresa.mx","firebaseEmail":"ana@empresa.mx"}`), now))
	must(svc.Ingest(p, batch("d1", "1.10", `{"platform":"android"}`, `{"type":"heartbeat"}`), now.Add(time.Minute)))

	var d domain.TelemetryDevice
	must(db.First(&d, "device_id = ?", "d1").Error)
	// La versión del último lote, no MAX(): como texto, «1.9» > «1.10».
	if d.AppVersion != "1.10" {
		t.Errorf("versión: %q", d.AppVersion)
	}
	// Un lote sin label no borra el que había.
	if d.Label != "Pixel 8" {
		t.Errorf("label: %q", d.Label)
	}
	// Un correo puesto como subject se guarda tapado.
	if strings.Contains(d.Subject, "@") || d.Subject != "[email]" {
		t.Errorf("subject: %q", d.Subject)
	}
	if d.LastBeatAt == nil || !d.LastBeatAt.Equal(now.Add(time.Minute)) {
		t.Errorf("latido: %v", d.LastBeatAt)
	}
	if !d.FirstSeen.Equal(now) || !d.LastSeen.Equal(now.Add(time.Minute)) {
		t.Errorf("visto: %v → %v", d.FirstSeen, d.LastSeen)
	}
	// En ninguna columna en claro de ninguna tabla.
	var leaks int64
	db.Raw(`SELECT COUNT(*) FROM telemetry_devices WHERE label LIKE '%@%' OR subject LIKE '%@%'`).Scan(&leaks)
	if leaks != 0 {
		t.Error("un correo llegó a una columna en claro")
	}
	// La ficha guardada es la del último lote con `device`.
	detail, err := svc.Device([]string{"o1"}, false, "p1", "d1", now.Add(2*time.Minute))
	must(err)
	if !strings.Contains(string(detail.Device), `"platform":"android"`) {
		t.Errorf("ficha: %s", detail.Device)
	}
	if len(detail.Heartbeats) != 1 {
		t.Errorf("latidos: %v", detail.Heartbeats)
	}
	// Otra organización no la ve.
	if other, _ := svc.Device([]string{"o2"}, false, "p1", "d1", now); other != nil {
		t.Error("otra organización ve la ficha")
	}
}

func TestDevicesAreSearchedAndPaged(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	repo := repository.NewTelemetryRepository(db)
	svc := NewTelemetryService(repo, repository.NewReportProjectRepository(db))
	rule := domain.HealthRule{Condition: domain.Condition{Path: "battery", Op: "<", Value: 0.2},
		Severity: domain.SeverityError, Message: "batería baja"}
	p := newProject(t, db, "p1", "o1", domain.TelemetryConfig{HealthRules: []domain.HealthRule{rule}})
	q := newProject(t, db, "p2", "o2", domain.TelemetryConfig{})
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	for i, d := range []struct{ id, dev string }{
		{"a", `{"label":"Moto G","subject":"E-1","battery":0.1}`},
		{"b", `{"label":"Pixel","subject":"E-2","battery":0.9}`},
		{"c", `{"label":"Galaxy","subject":"E-3"}`},
	} {
		if err := svc.Ingest(p, batch(d.id, "1", d.dev, `{"type":"lifecycle","level":"warn"}`), now.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.Ingest(q, batch("z", "1", `{"label":"Ajeno"}`), now); err != nil {
		t.Fatal(err)
	}
	list := func(dq repository.DeviceQuery) domain.TelemetryDevicePage {
		t.Helper()
		dq.OrgIDs = []string{"o1"}
		page, err := svc.ListDevices(dq)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	ids := func(p domain.TelemetryDevicePage) string {
		out := []string{}
		for _, d := range p.Devices {
			out = append(out, d.DeviceID)
		}
		return strings.Join(out, ",")
	}
	if got := ids(list(repository.DeviceQuery{})); got != "c,b,a" {
		t.Errorf("todos, el más reciente primero: %s", got)
	}
	for term, want := range map[string]string{"e-2": "b", "moto": "a", "c": "c", "ajeno": ""} {
		if got := ids(list(repository.DeviceQuery{Q: term})); got != want {
			t.Errorf("buscar %q: %q, quería %q", term, got, want)
		}
	}
	// `_` y `%` se buscan literalmente, no como comodines.
	if got := ids(list(repository.DeviceQuery{Q: "_"})); got != "" {
		t.Errorf("un _ hizo de comodín: %q", got)
	}
	first := list(repository.DeviceQuery{Limit: 2})
	if ids(first) != "c,b" || first.NextCursor == "" {
		t.Fatalf("primera página: %s %q", ids(first), first.NextCursor)
	}
	second := list(repository.DeviceQuery{Limit: 2, Cursor: first.NextCursor})
	if ids(second) != "a" || second.NextCursor != "" {
		t.Fatalf("segunda página: %s %q", ids(second), second.NextCursor)
	}
	a := second.Devices[0]
	if a.Label != "Moto G" || a.Subject != "E-1" || a.WarnCount != 1 || a.ErrorCount != 0 || a.Batches != 1 {
		t.Errorf("la fila: %+v", a)
	}
	if len(a.Alerts) != 1 || a.Alerts[0].Message != "batería baja" {
		t.Errorf("alertas: %+v", a.Alerts)
	}
	if _, err := svc.ListDevices(repository.DeviceQuery{OrgIDs: []string{"o1"}, Cursor: "basura"}); err == nil {
		t.Error("un cursor roto pasó")
	}
}

func TestEachProjectKeepsTelemetryForItsOwnWindow(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	repo := repository.NewTelemetryRepository(db)
	svc := NewTelemetryService(repo, repository.NewReportProjectRepository(db))
	short := newProject(t, db, "short", "o1", domain.TelemetryConfig{RetentionDays: 1})
	long := newProject(t, db, "long", "o1", domain.TelemetryConfig{RetentionDays: 30})
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	then := now.Add(-48 * time.Hour)
	for _, p := range []*domain.ReportProject{short, long} {
		if err := svc.Ingest(p, batch("d", "1", `{"label":"x"}`), then); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.Purge(now); err != nil {
		t.Fatal(err)
	}
	count := func(table, project string) (n int64) {
		db.Table(table).Where("project_id = ?", project).Count(&n)
		return
	}
	if count("telemetry_events", "short") != 0 || count("telemetry_devices", "short") != 0 {
		t.Error("el de un día sigue guardado a los dos")
	}
	if count("telemetry_events", "long") != 1 || count("telemetry_devices", "long") != 1 {
		t.Error("el de treinta se borró a los dos")
	}
}

func TestTheTimelineFiltersByTimeAndPagesBackwards(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	repo := repository.NewTelemetryRepository(db)
	svc := NewTelemetryService(repo, repository.NewReportProjectRepository(db))
	p := newProject(t, db, "p1", "o1", domain.TelemetryConfig{})
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		if err := svc.Ingest(p, batch("d", "1", "", `{"type":"network","status":500}`), now.Add(time.Duration(i)*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	at := func(h int) *time.Time { x := now.Add(time.Duration(h) * time.Hour); return &x }
	got, err := svc.Timeline([]string{"o1"}, false, domain.TimelineQuery{DeviceID: "d", Since: at(1), Until: at(2)})
	if err != nil || len(got) != 2 {
		t.Fatalf("since/until: %d %v", len(got), err)
	}
	got, _ = svc.Timeline([]string{"o1"}, false, domain.TimelineQuery{DeviceID: "d", Before: at(3), Limit: 2})
	if len(got) != 2 || !got[0].ReceivedAt.Equal(*at(2)) || !got[1].ReceivedAt.Equal(*at(1)) {
		t.Fatalf("before: %+v", got)
	}
	if got[0].ErrorCount != 1 || len(got[0].Severities) != 1 || got[0].Severities[0] != domain.SeverityError {
		t.Errorf("la gravedad no viaja: %+v", got[0])
	}
}

func TestBatchesFromBeforeTheTableGetTheirDevice(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	repo := repository.NewTelemetryRepository(db)
	svc := NewTelemetryService(repo, repository.NewReportProjectRepository(db))
	newProject(t, db, "p1", "o1", domain.TelemetryConfig{})
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	for i, dev := range []string{`{"device":{"manufacturer":"Google","modelName":"Pixel 8"}}`, `{"device":{"manufacturer":"Google","modelName":"Pixel 9"}}`} {
		blob, _ := json.Marshal(map[string]any{"device": json.RawMessage(dev), "breadcrumbs": []any{}})
		enc, err := repository.EncryptTelemetry(blob)
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.Create(&domain.TelemetryEvent{ProjectID: "p1", OrgID: "o1", DeviceID: "old",
			AppVersion: fmt.Sprint(i), Payload: enc, ReceivedAt: now.Add(time.Duration(i) * time.Hour), ExpiresAt: now.Add(48 * time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := svc.BackfillDevices()
	if err != nil || n != 1 {
		t.Fatalf("rellenó %d: %v", n, err)
	}
	var d domain.TelemetryDevice
	if err := db.First(&d, "device_id = ?", "old").Error; err != nil {
		t.Fatal(err)
	}
	if d.Label != "Google Pixel 9" || d.AppVersion != "1" || !d.FirstSeen.Equal(now) || !d.LastSeen.Equal(now.Add(time.Hour)) {
		t.Errorf("%+v", d)
	}
	if n, _ := svc.BackfillDevices(); n != 0 {
		t.Errorf("la segunda vez rellenó %d", n)
	}
}

func TestTheTelemetryConfigIsSaved(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	projects := repository.NewReportProjectRepository(db)
	p := newProject(t, db, "p1", "o1", domain.TelemetryConfig{})
	// Una fila de antes de la columna: NULL se lee como vacía.
	db.Exec(`UPDATE report_projects SET telemetry_config = NULL WHERE id = 'p1'`)
	got, err := projects.FindByID("p1")
	if err != nil || got.TelemetryConfig.Heartbeat != nil || len(got.TelemetryConfig.HealthRules) != 0 {
		t.Fatalf("%+v %v", got, err)
	}
	p.TelemetryConfig = domain.TelemetryConfig{RetentionDays: 45, Heartbeat: &domain.Heartbeat{IntervalSeconds: 300}}
	if err := projects.Update(p); err != nil {
		t.Fatal(err)
	}
	got, _ = projects.FindByID("p1")
	if got.TelemetryConfig.RetentionDays != 45 || got.TelemetryConfig.Heartbeat == nil {
		t.Fatalf("no se guardó: %+v", got.TelemetryConfig)
	}
}

// El compare-and-swap de verdad, en Postgres: el segundo que lee el mismo
// estado no gana. Es lo que impide que dos réplicas avisen las dos.
func TestOnlyOneSwapWinsAnIncident(t *testing.T) {
	db, done := telemetryDB(t)
	defer done()
	repo := repository.NewTelemetryRepository(db)
	svc := NewTelemetryService(repo, repository.NewReportProjectRepository(db))
	p := newProject(t, db, "p1", "o1", domain.TelemetryConfig{})
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	if err := svc.Ingest(p, batch("d", "1", `{"label":"x"}`), now); err != nil {
		t.Fatal(err)
	}
	var d domain.TelemetryDevice
	if err := db.First(&d, "device_id = ?", "d").Error; err != nil {
		t.Fatal(err)
	}
	won, err := repo.SwapIncidents(d.ID, nil, nil, &now, nil)
	if err != nil || !won {
		t.Fatalf("el primero no ganó: %v %v", won, err)
	}
	if won, _ := repo.SwapIncidents(d.ID, nil, nil, &now, nil); won {
		t.Fatal("el segundo, con el estado viejo, también ganó")
	}
	if won, _ := repo.SwapIncidents(d.ID, &now, nil, nil, nil); !won {
		t.Fatal("con el estado actual no se pudo cerrar")
	}
}
