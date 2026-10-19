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
)

/*
El alta por correo vista desde fuera: quién puede dar de alta, que el enlace
del correo funcione sin sesión, y el freno de pedir enlaces. Sin correo
configurado, así que el alta devuelve el enlace al admin (y la prueba lo usa).
*/

type accountHTTP struct {
	db *gorm.DB
	r  *chi.Mux
}

func accountHTTPSetup(t *testing.T) *accountHTTP {
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
	name := fmt.Sprintf("cac_test_account_http_%d", time.Now().UnixNano())
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if inner, _ := admin.DB(); inner != nil {
			inner.Close()
		}
	})
	if err := db.AutoMigrate(&domain.User{}, &domain.Organization{}, &domain.OrgMembership{},
		&domain.OrgInvitation{}, &domain.AccountLink{}, &domain.RefreshSession{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureUserIndexes(db); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, q := range []*gorm.DB{
		db.Exec(`INSERT INTO users (id, username, email, name, password, created_at, updated_at) VALUES
			('u-1','ana','ana@x.io','Ana','x',?,?), ('u-2','bea','bea@x.io','Bea','x',?,?)`, now, now, now, now),
		db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org-1','Uno','uno',?,?)`, now, now),
		db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES ('org-1','u-1','admin',?), ('org-1','u-2','member',?)`, now, now),
	} {
		if q.Error != nil {
			t.Fatal(q.Error)
		}
	}
	hub := events.NewHub()
	r := chi.NewRouter()
	accounts := NewAccountHandlerFor(db, hub, nil)
	mountPublicAccountRoutes(r, accounts)
	InitOrganizationRoutes(db, r, hub, accounts)
	return &accountHTTP{db: db, r: r}
}

func (f *accountHTTP) call(t *testing.T, method, path, body, userID string, orgs ...domain.OrgMembershipClaim) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.7:1234"
	if userID != "" {
		pair, err := repository.GenerateTokens(userID, userID, false, orgs)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	}
	rec := httptest.NewRecorder()
	f.r.ServeHTTP(rec, req)
	return rec
}

// Sólo un admin de la organización da de alta; un miembro, no, y sin sesión
// tampoco. Y el enlace que recibe el admin abre, sin sesión, la página que
// termina el registro. Mutantes: montar el alta fuera del grupo con JWT; sin
// mirar que sea admin.
func TestOnlyAnOrgAdminCreatesAccountsAndTheLinkWorksWithoutASession(t *testing.T) {
	f := accountHTTPSetup(t)
	body := `{"name":"Caro","email":"caro@x.io","role":"member"}`
	if rec := f.call(t, "POST", "/api/v1/organizations/org-1/accounts", body, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión → %d", rec.Code)
	}
	member := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleMember}
	if rec := f.call(t, "POST", "/api/v1/organizations/org-1/accounts", body, "u-2", member); rec.Code != http.StatusForbidden {
		t.Fatalf("un miembro → %d %s", rec.Code, rec.Body.String())
	}
	admin := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleAdmin}
	rec := f.call(t, "POST", "/api/v1/organizations/org-1/accounts", body, "u-1", admin)
	var out domain.APIResponse[domain.CreateAccountResponse]
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != http.StatusCreated || out.Data.Link == "" {
		t.Fatalf("el admin → %d %s", rec.Code, rec.Body.String())
	}
	token := out.Data.Link[strings.Index(out.Data.Link, "#")+1:]

	rec = f.call(t, "POST", "/api/v1/public/account/inspect", `{"token":"`+token+`"}`, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"orgName":"Uno"`) {
		t.Fatalf("mirar el enlace sin sesión → %d %s", rec.Code, rec.Body.String())
	}
	rec = f.call(t, "POST", "/api/v1/public/account/welcome", `{"token":"`+token+`","username":"bea","password":"una-buena-8"}`, "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "username-taken") {
		t.Fatalf("un usuario ocupado → %d %s", rec.Code, rec.Body.String())
	}
	rec = f.call(t, "POST", "/api/v1/public/account/welcome", `{"token":"`+token+`","username":"caro","password":"una-buena-8","client":"web"}`, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accessToken"`) {
		t.Fatalf("terminar el registro → %d %s", rec.Code, rec.Body.String())
	}
	rec = f.call(t, "POST", "/api/v1/public/account/welcome", `{"token":"`+token+`","username":"otra","password":"una-buena-8"}`, "")
	if rec.Code != http.StatusGone {
		t.Fatalf("el enlace otra vez → %d %s", rec.Code, rec.Body.String())
	}
}

// Pedir el enlace se frena por cuenta, y la respuesta no dice si la cuenta
// existe. Sin correo configurado, lo dice (no hay otra forma de recibirlo).
// Mutante: no contar las peticiones.
func TestAskingForResetLinksIsThrottled(t *testing.T) {
	f := accountHTTPSetup(t)
	for i := 0; i < 3; i++ {
		if rec := f.call(t, "POST", "/api/v1/public/account/forgot", `{"login":"ana"}`, ""); rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("petición %d sin correo → %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if rec := f.call(t, "POST", "/api/v1/public/account/forgot", `{"login":"ana"}`, ""); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("la cuarta → %d", rec.Code)
	}
}

// Las rutas del enlace son las únicas sin JWT de las de cuentas.
func TestThePublicAccountRoutesSkipAuth(t *testing.T) {
	f := accountHTTPSetup(t)
	for _, p := range []string{"inspect", "welcome", "forgot", "reset"} {
		if rec := f.call(t, "POST", "/api/v1/public/account/"+p, `{}`, ""); rec.Code == http.StatusUnauthorized {
			t.Errorf("%s pide sesión y es para quien no la tiene", p)
		}
	}
	if rec := f.call(t, "POST", "/api/v1/organizations/org-1/accounts/u-2/resend", `{}`, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("reenviar sin sesión → %d", rec.Code)
	}
}
