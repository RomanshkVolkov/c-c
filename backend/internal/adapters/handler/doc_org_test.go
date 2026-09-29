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

// Abrir un documento dice de qué organización es, **aunque todavía no exista**.
//
// La app no pinta el documento de una org dentro de otra, y cuando llega a uno
// por un enlace cambia a la suya. Para las dos cosas necesita la org, y con un
// nodo sin documento `doc` viene nil: sin este campo no habría de dónde
// sacarla. El handler ya la conocía —`resolveOwner` la calcula para comprobar
// la pertenencia— y la tiraba.
func TestOpeningADocSaysWhichOrgItBelongsTo(t *testing.T) {
	db, cleanup := docOrgDB(t)
	defer cleanup()
	h := &docHandler{svc: service.NewDocService(repository.NewDocRepository(db))}

	// Un superadmin, que ve las dos: así la org que sale no puede ser «la
	// única que tiene».
	claims := &domain.ClaimsJWT{UserID: "u-root", Username: "root", Superadmin: true}
	for _, c := range []struct{ space, org string }{{"esp-1", "org-1"}, {"esp-2", "org-2"}} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/docs/space/"+c.space, nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("kind", "space")
		rctx.URLParams.Add("ownerId", c.space)
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
		ctx = context.WithValue(ctx, repository.UserContextKey, claims)
		rec := httptest.NewRecorder()
		h.Get(rec, r.WithContext(ctx))

		if rec.Code != http.StatusOK {
			t.Fatalf("%s → %d: %s", c.space, rec.Code, rec.Body.String())
		}
		var res struct {
			Data struct {
				Doc   *domain.Doc `json:"doc"`
				OrgID string      `json:"orgId"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		if res.Data.Doc != nil {
			t.Fatalf("la fixture no tiene documento y llegó uno: %+v", res.Data.Doc)
		}
		if res.Data.OrgID != c.org {
			t.Errorf("%s es de %s y dijo %q", c.space, c.org, res.Data.OrgID)
		}
	}
}

func docOrgDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_doc_org"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.TaskSpace{}, &domain.Doc{}); err != nil {
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
		VALUES ('esp-1','org-1','Uno','#fff','0.5',?,?), ('esp-2','org-2','Dos','#fff','0.5',?,?)`,
		ahora, ahora, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
