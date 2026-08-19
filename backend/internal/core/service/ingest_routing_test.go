package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
Un reporte que entra tiene que aterrizar en algún sitio.

El fallo: el ingest construía la fila sin `org_id` ni `list_id`. La migración a
items se los puso una vez a los que ya existían y desde entonces cada reporte de
cliente entraba huérfano — fuera de todo tablero, y con un detalle que contestaba
«list not found». Se supo porque una notificación apuntó a uno y no abría.

Los dos valores salen del proyecto que la llave de ingesta ya identificó.
*/

func TestUnReporteQueEntraAterrizaEnLaListaDelCanal(t *testing.T) {
	db, cleanup := ingestDB(t, conLista)
	defer cleanup()
	svc := reportSvcRuta(db)

	res, err := svc.Ingest(context.Background(), proyectoDe(t, db), domain.IngestReportInput{
		Title: "Meter buscador a proveedores", ReporterName: "Sebastian",
	})
	if err != nil {
		t.Fatal(err)
	}

	var fila domain.Item
	if err := db.First(&fila, "id = ?", res.ID).Error; err != nil {
		t.Fatal(err)
	}
	if fila.ListID != "lista-1" {
		t.Errorf("sin lista no sale en ninguna columna; quedó en %q", fila.ListID)
	}
	if fila.OrgID != "org-1" {
		t.Errorf("sin organización no lo ve nadie; quedó en %q", fila.OrgID)
	}
	// La tercera desnormalizada. Hoy no la filtra ninguna consulta de reportes,
	// pero dejar una de las tres a medias es exactamente cómo empezó esto.
	if fila.SpaceID != "esp-1" {
		t.Errorf("el espacio también sale de la lista; quedó en %q", fila.SpaceID)
	}
}

// Y se puede abrir. Es lo que se pulsó en la notificación y devolvió un 500.
func TestElReporteReciénEntradoSeAbre(t *testing.T) {
	db, cleanup := ingestDB(t, conLista)
	defer cleanup()
	res, err := reportSvcRuta(db).Ingest(context.Background(), proyectoDe(t, db),
		domain.IngestReportInput{Title: "Algo"})
	if err != nil {
		t.Fatal(err)
	}
	tareas := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil)
	detalle, err := tareas.Detail(res.ID)
	if err != nil {
		t.Fatalf("el detalle tiene que abrir: %v", err)
	}
	if detalle.ListName != "tasks" {
		t.Errorf("y decir en qué lista está; dijo %q", detalle.ListName)
	}
}

// Un canal sin lista no pierde el reporte, y lo que entra se puede leer igual.
//
// Es la regla del resto del ingest —una categoría rara se normaliza, no se
// rechaza—: perder el reporte de un cliente por un hueco de configuración
// nuestro es el peor de los dos fallos posibles.
func TestUnCanalSinListaNoPierdeElReporteYSeSigueLeyendo(t *testing.T) {
	db, cleanup := ingestDB(t, sinLista)
	defer cleanup()
	res, err := reportSvcRuta(db).Ingest(context.Background(), proyectoDe(t, db),
		domain.IngestReportInput{Title: "Sin sitio"})
	if err != nil {
		t.Fatalf("no se rechaza: %v", err)
	}
	tareas := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil)
	detalle, err := tareas.Detail(res.ID)
	if err != nil {
		t.Fatalf("sin lista se lee igual, no revienta: %v", err)
	}
	if detalle.ListName != "" {
		t.Errorf("y no se inventa una lista; dijo %q", detalle.ListName)
	}
}

// Y un item que apunta a una lista que ya no está tampoco tumba el detalle.
//
// Es un caso distinto del de arriba —allí no hay `list_id`, aquí lo hay y cuelga
// de nada— y hace falta escribirlo aparte: la tolerancia del `Detail` a un id
// colgado no la ejercita ningún otro test, y código defensivo que nadie prueba
// es código que no se sabe si defiende.
func TestUnItemQueApuntaAUnaListaQueYaNoEstaSeSigueLeyendo(t *testing.T) {
	db, cleanup := ingestDB(t, conLista)
	defer cleanup()
	res, err := reportSvcRuta(db).Ingest(context.Background(), proyectoDe(t, db),
		domain.IngestReportInput{Title: "Colgado"})
	if err != nil {
		t.Fatal(err)
	}
	// La lista desaparece por debajo, que es el estado que deja cualquier
	// limpieza mal hecha en la base.
	if err := db.Exec(`DELETE FROM task_lists WHERE id = 'lista-1'`).Error; err != nil {
		t.Fatal(err)
	}
	tareas := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil)
	if _, err := tareas.Detail(res.ID); err != nil {
		t.Fatalf("un id colgado no puede tumbar la lectura: %v", err)
	}
}

// La invariante: un canal tiene siempre una bandeja, y es una lista de verdad.
// Moverla sí; dejarlo en nada, no.
func TestUnCanalNoSePuedeQuedarSinBandeja(t *testing.T) {
	db, cleanup := ingestDB(t, conLista)
	defer cleanup()
	tareas := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil)

	if err := tareas.BindList("lista-1", ""); err == nil {
		t.Fatal("desvincular la bandeja de un canal tiene que negarse")
	} else if err != repository.ErrChannelNeedsInbox {
		t.Fatalf("y decir por qué; dijo %v", err)
	}

	// Repuntarla a otra lista sigue siendo legítimo, y mueve la bandeja.
	if err := tareas.BindList("lista-2", "proj-1"); err != nil {
		t.Fatal(err)
	}
	var p domain.ReportProject
	if err := db.First(&p, "id = ?", "proj-1").Error; err != nil {
		t.Fatal(err)
	}
	if p.ListID == nil || *p.ListID != "lista-2" {
		t.Errorf("la última elección explícita gana; la bandeja quedó en %v", p.ListID)
	}
}

// ─── andamiaje ────────────────────────────────────────────────────────────────

type conQue int

const (
	conLista conQue = iota
	sinLista
)

func reportSvcRuta(db *gorm.DB) *ReportService {
	return NewReportService(
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		repository.NewAuthRepository(db),
		nil, nil,
	)
}

func proyectoDe(t *testing.T, db *gorm.DB) *domain.ReportProject {
	t.Helper()
	var p domain.ReportProject
	if err := db.First(&p, "id = ?", "proj-1").Error; err != nil {
		t.Fatal(err)
	}
	return &p
}

func ingestDB(t *testing.T, que conQue) (*gorm.DB, func()) {
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
	name := fmt.Sprintf("cac_test_ingest_%d", que)
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&domain.User{}, &domain.Organization{}, &domain.OrgMembership{},
		&domain.TaskSpace{}, &domain.TaskList{}, &domain.Item{},
		&domain.ItemComment{}, &domain.ItemAssignee{}, &domain.ItemWatcher{},
		&domain.ItemAttachment{}, &domain.ReportProject{},
		&domain.TaskTag{}, &domain.TaskTagLink{},
	); err != nil {
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
		VALUES ('org-1','Uno','uno',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-1','org-1','Portento','#fff','m',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO task_lists (id, space_id, name, rank, project_id, created_at, updated_at)
		VALUES ('lista-1','esp-1','tasks','m','proj-1',?,?), ('lista-2','esp-1','otra','n',NULL,?,?)`,
		ahora, ahora, ahora, ahora))

	lista := "'lista-1'"
	if que == sinLista {
		lista = "NULL"
	}
	must(db.Exec(`INSERT INTO report_projects (id, org_id, name, slug, ingest_key_hash, is_active, list_id, created_at, updated_at)
		VALUES ('proj-1','org-1','Portento','portento','\x00',true,`+lista+`,?,?)`, ahora, ahora))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
