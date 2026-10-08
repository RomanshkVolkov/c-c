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
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// La lista de dispositivos sigue siendo un array en `data`. Es la promesa que
// deja desplegar el backend antes que la app: una app sin actualizar lee la
// respuesta como siempre, y la paginación viaja en la última fila (`cursor`).

func telemetryHandlerDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_telemetry_handler"
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
	t.Setenv("REPORTS_KEK", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

func TestTheDeviceListIsStillAnArray(t *testing.T) {
	db, done := telemetryHandlerDB(t)
	defer done()
	projects := repository.NewReportProjectRepository(db)
	svc := service.NewTelemetryService(repository.NewTelemetryRepository(db), projects)
	p := &domain.ReportProject{BaseModel: domain.BaseModel{ID: "p1"}, OrgID: "o1", Name: "P", Slug: "p", IngestKeyHash: []byte("k"), IsActive: true}
	if err := db.Create(p).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i, id := range []string{"a", "b"} {
		b := domain.IngestEventBatch{DeviceID: id, Device: json.RawMessage(`{"label":"L"}`)}
		if err := svc.Ingest(p, b, now.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	h := NewTelemetryAdminHandler(svc)
	r := chi.NewRouter()
	r.Get("/devices", h.ListDevices)
	r.Get("/devices/{projectId}/{deviceId}", h.Device)
	r.Get("/timeline", h.Timeline)
	call := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		claims := &domain.ClaimsJWT{UserID: "u", Orgs: []domain.OrgMembershipClaim{{OrgID: "o1"}}}
		req = req.WithContext(context.WithValue(req.Context(), repository.UserContextKey, claims))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	w := call("/devices?limit=1")
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(body.Data) != 1 || body.Data[0]["deviceId"] != "b" || body.Data[0]["label"] != "L" {
		t.Fatalf("%v", body.Data)
	}
	cursor, _ := body.Data[0]["cursor"].(string)
	if cursor == "" {
		t.Fatal("la última fila no lleva el cursor")
	}
	w = call("/devices?limit=1&cursor=" + cursor)
	body.Data = nil
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if len(body.Data) != 1 || body.Data[0]["deviceId"] != "a" || body.Data[0]["cursor"] != nil {
		t.Fatalf("segunda página: %v", body.Data)
	}

	if w := call("/devices/p1/nope"); w.Code != http.StatusNotFound {
		t.Errorf("un dispositivo que no existe: %d", w.Code)
	}
	if w := call("/devices/p1/a"); w.Code != http.StatusOK {
		t.Errorf("la ficha: %d %s", w.Code, w.Body)
	}
	if w := call("/timeline?deviceId=a&since=ayer"); w.Code != http.StatusBadRequest {
		t.Errorf("una fecha rota: %d", w.Code)
	}
	if w := call("/timeline?deviceId=a&since=" + fmt.Sprint(now.Add(-time.Hour).UnixMilli())); w.Code != http.StatusOK {
		t.Errorf("since en milisegundos: %d %s", w.Code, w.Body)
	}
}
