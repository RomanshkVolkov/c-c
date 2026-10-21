package http

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Un agente se avisa a sí mismo por la ruta de verdad (#153): sin el permiso
// `notify:me` no pasa; con él, deja el aviso en la campana de la persona del
// token y en la de nadie más, aunque mande otro destinatario en el cuerpo.
// Mutantes: quitar la ruta del mapa de permisos (un token no llega); tomar el
// destinatario del cuerpo.
func TestATokenNotifiesOnlyItsOwner(t *testing.T) {
	db := selfNoticeDB(t)
	r := chi.NewRouter()
	InitNotificationRoutes(db, r, events.NewHub(), nil)

	scopes := map[string][]string{"cac_pat_sin": nil, "cac_pat_con": {domain.ScopeNotifyMe}}
	middleware.UsePATAuthenticator(func(tok string) (*domain.ClaimsJWT, error) {
		s, ok := scopes[tok]
		if !ok {
			return nil, fmt.Errorf("desconocido")
		}
		return &domain.ClaimsJWT{UserID: "u-jose", Username: "jose", Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1"}}, Scopes: s}, nil
	})
	defer middleware.UsePATAuthenticator(nil)

	send := func(tok, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/notifications/self", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	body := `{"title":"Paré: hay una decisión","link":"/tasks","userId":"u-bea"}`
	if rec := send("cac_pat_sin", body); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "missing-scope:notify:me") {
		t.Fatalf("sin el permiso → %d %s", rec.Code, rec.Body.String())
	}
	if rec := send("cac_pat_con", body); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"orgId":"org-1"`) {
		t.Fatalf("con el permiso → %d %s", rec.Code, rec.Body.String())
	}
	var rows []domain.Notification
	if err := db.Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].UserID != "u-jose" || rows[0].OrgID != "org-1" || rows[0].Kind != domain.SelfNoticeKind {
		t.Fatalf("en la campana: %+v", rows)
	}
}

func selfNoticeDB(t *testing.T) *gorm.DB {
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
	const name = "cac_test_self_notice"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Fatalf("DB_HOST is set but a throwaway database cannot be created: %v", err)
	}
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.User{}, &domain.Notification{}, &domain.NotificationPrefs{}); err != nil {
		t.Fatal(err)
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
