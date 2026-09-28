package service

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Pedir que se revise un documento, sin firmarlo (#92).
//
// El aviso va al responsable del doc —que sabe si sigue siendo verdad— y a los
// superadmins, que hoy son los únicos que pueden firmar: avisar sólo al
// responsable sería pedirle algo que quizá no puede cumplir. Y la petición se
// queda en el doc hasta que alguien firma.

// El mutante que mata cada caso está en su nombre.
func TestReviewRecipients(t *testing.T) {
	for _, c := range []struct {
		caso                  string
		responsable, pide     string
		admins                []string
		want                  []string
	}{
		{"responsable y superadmins", "u-resp", "u-agente", []string{"u-jose"}, []string{"u-jose", "u-resp"}},
		{"sin responsable, sólo los superadmins", "", "u-agente", []string{"u-jose"}, []string{"u-jose"}},
		// Que te avise de lo que acabas de hacer es el fallo que ya se quitó del chat.
		{"quien la pide no se avisa a sí mismo", "u-jose", "u-jose", []string{"u-jose", "u-ana"}, []string{"u-ana"}},
		{"el responsable superadmin, una sola vez", "u-jose", "u-agente", []string{"u-jose"}, []string{"u-jose"}},
	} {
		t.Run(c.caso, func(t *testing.T) {
			got := reviewRecipients(c.responsable, c.pide, c.admins)
			sort.Strings(got)
			sort.Strings(c.want)
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Errorf("salió %v, y es %v", got, c.want)
			}
		})
	}
}

type captaAvisos struct{ avisos []domain.Aviso }

func (c *captaAvisos) Notify(a domain.Aviso) { c.avisos = append(c.avisos, a) }

func reviewDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_review_request"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.OrgMembership{}, &domain.TaskList{}, &domain.Doc{}, &domain.DocTab{}); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	for _, q := range []string{
		`INSERT INTO users (id, username, email, password, is_superadmin, created_at, updated_at) VALUES ('u-jose','jose','j@x.io','x',true,?,?)`,
		`INSERT INTO users (id, username, email, password, is_superadmin, created_at, updated_at) VALUES ('u-resp','ana','a@x.io','x',false,?,?)`,
		`INSERT INTO users (id, username, email, password, is_superadmin, created_at, updated_at) VALUES ('u-agente','bot','b@x.io','x',false,?,?)`,
		`INSERT INTO task_lists (id, space_id, name, created_at, updated_at) VALUES ('list-1','sp','Runbook de Koa',?,?)`,
		// Ana es de la organización: sin eso no se la puede poner de responsable,
		// y el servicio lo comprueba con razón.
		`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES ('org-1','u-resp','member',?)`,
	} {
		args := []any{ahora, ahora}
		if strings.Count(q, "?") == 1 {
			args = args[:1]
		}
		if err := db.Exec(q, args...).Error; err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

// De punta a punta: pedirla la deja a la vista y avisa a quien toca; firmarla
// la quita.
//
// Los mutantes que mata: no guardar la petición, no avisar, y firmar sin
// contestar la petición —que dejaría a la vista algo que ya se hizo—.
func TestAReviewRequestStaysVisibleUntilSomebodySigns(t *testing.T) {
	db, cleanup := reviewDB(t)
	defer cleanup()
	campana := &captaAvisos{}
	svc := NewDocService(repository.NewDocRepository(db)).WithNotifier(campana)

	// El responsable del doc es Ana.
	quien := "u-resp"
	if _, err := svc.Patch("org-1", domain.DocOwnerList, "list-1", "u-jose", domain.PatchDocRequest{MaintainerID: &quien}); err != nil {
		t.Fatal(err)
	}

	d, err := svc.RequestReview("org-1", domain.DocOwnerList, "list-1", "u-agente", domain.ViaMCP,
		domain.ReviewRequest{Note: "  Cambié la sección de correo.  "})
	if err != nil {
		t.Fatal(err)
	}
	if d.ReviewRequestedAt == nil || d.ReviewRequestedBy != "u-agente" {
		t.Fatalf("la petición no quedó apuntada: %+v", d)
	}
	if d.ReviewRequestNote != "Cambié la sección de correo." {
		t.Errorf("la nota es %q", d.ReviewRequestNote)
	}
	if d.ReviewRequestedByName == "" {
		t.Error("tiene que decir quién la pidió")
	}

	// Avisos: Ana (responsable) y Jose (superadmin). El agente no.
	var a []string
	for _, x := range campana.avisos {
		a = append(a, x.UserID)
		if x.Kind != "doc:review" || x.Link != "/tasks?doc=list:list-1" || x.Group != domain.DocGroup("list", "list-1") {
			t.Errorf("aviso mal formado: %+v", x)
		}
		if x.TitleArgs["doc"] != "Runbook de Koa" {
			t.Errorf("el aviso tiene que nombrar el doc: %+v", x.TitleArgs)
		}
	}
	sort.Strings(a)
	if fmt.Sprint(a) != "[u-jose u-resp]" {
		t.Errorf("avisó a %v", a)
	}

	// Firmar la contesta.
	si := true
	if _, err := svc.Patch("org-1", domain.DocOwnerList, "list-1", "u-jose", domain.PatchDocRequest{Reviewed: &si}); err != nil {
		t.Fatal(err)
	}
	despues, err := svc.Get(domain.DocOwnerList, "list-1")
	if err != nil {
		t.Fatal(err)
	}
	if despues.ReviewRequestedAt != nil || despues.ReviewRequestedBy != "" || despues.ReviewRequestNote != "" {
		t.Errorf("firmar tenía que quitar la petición: %+v", despues)
	}
	if despues.ReviewedAt == nil {
		t.Error("y dejar la firma")
	}
}
