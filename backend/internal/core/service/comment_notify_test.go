package service

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
Quién se entera de que alguien contestó.

El fallo que trajo esto: un cliente comentó, la app estaba cerrada, y no quedó
constancia en ningún sitio. `task:comment` y `report:new` llevaban desde siempre
su interruptor en las preferencias y su pestaña en el panel, y ningún servicio
escribía una sola fila — sólo había aviso en vivo por el stream, que se pierde
entero si no hay nadie escuchando en ese instante.

La regla reparte por quién habla:

  - de fuera  → toda la organización;
  - de dentro → responsables, seguidores y quien ya escribió en el hilo.

El caso que se perdió es justo el primero con el item **sin nadie encima**, que
es el que cubre el primer test.
*/

const (
	ana  = "11111111-1111-4111-8111-111111111111"
	bea  = "22222222-2222-4222-8222-222222222222"
	caro = "33333333-3333-4333-8333-333333333333"
)

func avisadosDe(espia *notificadorEspia, kind string) []string {
	out := espia.paraQuien(kind)
	sort.Strings(out)
	return out
}

// El caso de portento-84: un item sin responsable ni seguidores, y un cliente
// que escribe. Antes no le llegaba a nadie — no porque se filtrara mal, sino
// porque no había filtro: nadie escribía la fila.
func TestUnComentarioDeClienteLlegaATodaLaOrganizacion(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := reportSvcDePrueba(db, espia)

	_, err := svc.AddProjectComment(context.Background(), domain.TenantAuthor{
		ProjectID: "proj-1", ProjectSlug: "portento",
		ExternalID: "3", ExternalName: "Sebastian Ramirez",
	}, "item-2", "sigue pasando lo mismo", nil)
	if err != nil {
		t.Fatal(err)
	}

	quienes := avisadosDe(espia, "task:comment")
	if len(quienes) != 3 {
		t.Fatalf("un cliente hablando es de toda la casa; le llegó a %v", quienes)
	}
	if quienes[0] != ana || quienes[1] != bea || quienes[2] != caro {
		t.Errorf("faltó alguien de la organización: %v", quienes)
	}
}

// El reporter contestando en su propio reporte entra por otra puerta, y tiene
// que repartirse igual: es la misma persona de fuera.
func TestElReporterEnSuPropioReporteTambienLlegaATodos(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := reportSvcDePrueba(db, espia)

	if _, err := svc.ReporterComment(context.Background(), "item-2", "hola!", nil); err != nil {
		t.Fatal(err)
	}
	if quienes := avisadosDe(espia, "task:comment"); len(quienes) != 3 {
		t.Errorf("el reporter es de fuera igual; llegó a %v", quienes)
	}
}

// Y lo de dentro no despierta a la casa entera. Bea lleva el item; caro no
// tiene nada que ver. Ana escribe, así que a ana no se le cuenta lo suyo.
func TestUnComentarioDeCompaneroSoloDespiertaAQuienEstaEnElHilo(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewTaskService(
		repository.NewTaskRepository(db),
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		nil,
	).WithNotifier(espia)

	if _, err := svc.AddComment(context.Background(), "item-1", ana, "lo miro", domain.VisibilityInternal); err != nil {
		t.Fatal(err)
	}

	quienes := avisadosDe(espia, "task:comment")
	if len(quienes) != 1 || quienes[0] != bea {
		t.Errorf("sólo quien está en el hilo, y nunca el autor; llegó a %v", quienes)
	}
}

// Quien ya escribió en el hilo cuenta como implicado: contestó una vez, le
// interesa la respuesta aunque no se apuntara a nada.
func TestQuienYaEscribioEnElHiloCuentaComoImplicado(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	ahora := time.Now()
	if err := db.Exec(`INSERT INTO item_comments (id, item_id, kind, visibility, author_user_id, body, created_at, updated_at)
		VALUES ('com-viejo','item-1','user','internal',?,'yo lo vi',?,?)`, caro, ahora, ahora).Error; err != nil {
		t.Fatal(err)
	}
	espia := &notificadorEspia{}
	svc := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil).WithNotifier(espia)

	if _, err := svc.AddComment(context.Background(), "item-1", ana, "gracias", domain.VisibilityInternal); err != nil {
		t.Fatal(err)
	}
	quienes := avisadosDe(espia, "task:comment")
	if len(quienes) != 2 || quienes[0] != bea || quienes[1] != caro {
		t.Errorf("bea lo lleva y caro ya había escrito; llegó a %v", quienes)
	}
}

// Un reporte recién llegado va a quien lleva la cuenta de ese cliente. Y si el
// proyecto no tiene a nadie puesto, a toda la organización — sin el respaldo
// sería el mismo agujero de antes con otra forma.
func TestElReporteNuevoVaAlResponsableYSiNoHayATodos(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()

	espia := &notificadorEspia{}
	a := &avisos{
		inbox: espia,
		items: repository.NewReportRepository(db),
		orgs:  repository.NewOrganizationRepository(db),
	}

	a.reporteNuevo(domain.ViaApp, "org-1", "item-1", bea, "New report · portento-84", "Algo falla")
	if quienes := avisadosDe(espia, "report:new"); len(quienes) != 1 || quienes[0] != bea {
		t.Errorf("con responsable puesto va sólo a él; fue a %v", quienes)
	}

	espia.avisos = nil
	a.reporteNuevo(domain.ViaApp, "org-1", "item-1", "", "New report · portento-85", "Otra cosa")
	if quienes := avisadosDe(espia, "report:new"); len(quienes) != 3 {
		t.Errorf("sin responsable no puede quedarse sin avisar a nadie; fue a %v", quienes)
	}
}

// La marca de origen llega hasta la fila.
//
// El servidor MCP escribe con el token de su dueño, así que sin esto una
// escritura del agente es indistinguible de una tuya. La cabecera la declara el
// cliente y no se puede verificar — por eso su trabajo es etiquetar, no impedir.
func TestLaMarcaDeOrigenViajaHastaLaNotificacion(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil).WithNotifier(espia)

	ctx := domain.WithVia(context.Background(), domain.ViaMCP)
	if _, err := svc.AddComment(ctx, "item-1", ana, "lo hago yo", domain.VisibilityInternal); err != nil {
		t.Fatal(err)
	}
	if vias := espia.viasDe("task:comment"); len(vias) != 1 || vias[0] != domain.ViaMCP {
		t.Errorf("la etiqueta del agente tiene que llegar a la fila; llegó %v", vias)
	}

	// Y lo que no la declara no la lleva: sin esto todo saldría etiquetado.
	espia.avisos = nil
	if _, err := svc.AddComment(context.Background(), "item-1", ana, "y esto a mano", domain.VisibilityInternal); err != nil {
		t.Fatal(err)
	}
	if vias := espia.viasDe("task:comment"); len(vias) != 1 || vias[0] != domain.ViaApp {
		t.Errorf("sin cabecera no hay etiqueta; llegó %v", vias)
	}
}

// Una cabecera inventada no se convierte en etiqueta: acabaría pintada en el
// panel de todo el mundo.
func TestUnaMarcaDesconocidaSeTrataComoLaApp(t *testing.T) {
	if v := domain.NormalizeVia("bot-de-alguien"); v != domain.ViaApp {
		t.Errorf("lo desconocido es como no decir nada, salió %q", v)
	}
}

// El hueco más grande que había: te ponían trabajo encima y no te enterabas.
func TestAsignarAvisaAlAsignadoYNoAQuienAsigna(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil).WithNotifier(espia)

	// Ana se asigna a sí misma y de paso a caro.
	nuevos := []string{ana, caro}
	if err := svc.UpdateTask(context.Background(), "item-1", ana,
		domain.UpdateTaskRequest{AssigneeIDs: &nuevos}); err != nil {
		t.Fatal(err)
	}
	quienes := avisadosDe(espia, "task:assigned")
	if len(quienes) != 1 || quienes[0] != caro {
		t.Errorf("a caro sí y a ana no, que fue quien lo hizo; llegó a %v", quienes)
	}
}

// Guardar responsables reemplaza la lista entera, así que sin la diferencia
// bea recibiría un aviso cada vez que alguien toca cualquier otra cosa.
func TestReasignarNoRepiteElAvisoAQuienYaLaTenia(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil).WithNotifier(espia)

	// bea ya lleva item-1 desde la fixture; se vuelve a guardar la misma lista.
	misma := []string{bea}
	if err := svc.UpdateTask(context.Background(), "item-1", ana,
		domain.UpdateTaskRequest{AssigneeIDs: &misma}); err != nil {
		t.Fatal(err)
	}
	if quienes := avisadosDe(espia, "task:assigned"); len(quienes) != 0 {
		t.Errorf("no cambió nada, no hay nada que avisar; llegó a %v", quienes)
	}
}

// Un cambio de estado interesa a quien lleva la tarjeta, no a la organización.
func TestCambiarDeEstadoAvisaALosImplicados(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil).WithNotifier(espia)

	if err := svc.MoveTask(context.Background(), "item-1", ana, domain.MoveTaskRequest{
		StatusID: "lista-1/resolved",
	}); err != nil {
		t.Fatal(err)
	}
	quienes := avisadosDe(espia, "task:status")
	if len(quienes) != 1 || quienes[0] != bea {
		t.Errorf("bea lo lleva; ana lo movió. Llegó a %v", quienes)
	}
}

// Reordenar dentro de la misma columna no es una noticia: es mover una tarjeta
// de sitio. Sin este corte, arrastrar para ordenar avisaría a media oficina.
func TestReordenarDentroDeLaMismaColumnaNoAvisa(t *testing.T) {
	db, cleanup := avisosDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewTaskService(repository.NewTaskRepository(db), repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil).WithNotifier(espia)

	// item-1 ya está en in_progress.
	if err := svc.MoveTask(context.Background(), "item-1", ana, domain.MoveTaskRequest{
		StatusID: "lista-1/in_progress",
	}); err != nil {
		t.Fatal(err)
	}
	if quienes := avisadosDe(espia, "task:status"); len(quienes) != 0 {
		t.Errorf("no cambió de estado; llegó a %v", quienes)
	}
}

func reportSvcDePrueba(db *gorm.DB, espia Notifier) *ReportService {
	return NewReportService(
		repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db),
		repository.NewAuthRepository(db),
		nil, // sin imágenes: ningún test de aquí manda ninguna
		nil, // sin hub
	).WithNotifier(espia)
}

func avisosDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_avisos"
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
		&domain.ItemComment{}, &domain.ItemAssignee{}, &domain.ItemWatcher{}, &domain.ItemAttachment{},
		&domain.ReportProject{},
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
	must(db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at) VALUES
		(?,'ana','a@x.io','x',?,?), (?,'bea','b@x.io','x',?,?), (?,'caro','c@x.io','x',?,?)`,
		ana, ahora, ahora, bea, ahora, ahora, caro, ahora, ahora))
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
		VALUES ('org-1','Uno','uno',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
		('org-1',?,'admin',?), ('org-1',?,'member',?), ('org-1',?,'member',?)`,
		ana, ahora, bea, ahora, caro, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at)
		VALUES ('esp-1','org-1','Uno','#fff','m',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO report_projects (id, org_id, name, slug, ingest_key_hash, is_active, created_at, updated_at)
		VALUES ('proj-1','org-1','Portento','portento','\x00',true,?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO task_lists (id, space_id, name, rank, project_id, created_at, updated_at)
		VALUES ('lista-1','esp-1','tasks','m','proj-1',?,?)`, ahora, ahora))
	must(db.Exec(`INSERT INTO items (id, org_id, project_id, list_id, seq, title, description,
		status, category, priority, origin, visibility, reporter_id, reporter_name, created_at, updated_at)
		VALUES ('item-1','org-1','proj-1','lista-1',84,'Desplegar leyenda','...',
		'in_progress','ui','normal','user','public','3','Sebastian Ramirez',?,?)`, ahora, ahora))
	// item-2 es la reproducción exacta de portento-84: **sin responsable y sin
	// seguidores**. Por «los implicados» no le llegaría a nadie, y eso es lo que
	// pasó de verdad.
	must(db.Exec(`INSERT INTO items (id, org_id, project_id, list_id, seq, title, description,
		status, category, priority, origin, visibility, reporter_id, reporter_name, created_at, updated_at)
		VALUES ('item-2','org-1','proj-1','lista-1',85,'Nadie lo lleva','...',
		'pending','ui','normal','user','public','3','Sebastian Ramirez',?,?)`, ahora, ahora))
	// Bea lleva el item-1, que es el que usan las pruebas de lo interno.
	must(db.Exec(`INSERT INTO item_assignees (item_id, user_id, "primary") VALUES ('item-1',?,true)`, bea))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
