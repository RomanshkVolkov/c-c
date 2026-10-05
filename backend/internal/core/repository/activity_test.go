package repository

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

/*
Los runs de GitHub Actions (R9), contra Postgres de verdad: lo que se fija es
lo que GORM no puede garantizar solo —que un webhook tardío no deshaga uno
posterior, y que un re-run sea su propia fila—, y después el feed que los
mezcla con los deploys.
*/

func activityDB(t *testing.T) *gorm.DB {
	t.Helper()
	if GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			GetEnv("DB_HOST", "localhost"), GetEnv("DB_PORT", "5432"),
			GetEnv("DB_USER", "postgres"), GetEnv("DB_PASSWORD", ""),
			name, GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_test_activity"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.WorkflowRun{}, &domain.Deployable{}, &domain.Deployment{}, &domain.ImageBuild{}); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDeployIndexes(db); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})
	return db
}

func aRun(id int64, attempt int, status, conclusion string, at time.Time) *domain.WorkflowRun {
	r := &domain.WorkflowRun{
		OrgID: "org-1", RepoID: 100, RepoFullName: "dwit/api",
		RunID: id, RunAttempt: attempt, Status: status, Conclusion: conclusion,
		Path: ".github/workflows/prod.yml", WorkflowName: "Deploy", Actor: "ana",
		HeadSha: "abc1234", HeadBranch: "main", OccurredAt: at,
	}
	r.ID = fmt.Sprintf("run-%d-%d", id, attempt)
	return r
}

// Un `in_progress` que llega después del `completed` (una reentrega) no vuelve
// a poner «en curso» un run que ya terminó, ni le borra la conclusión. El
// mutante que mata: quitar el WHERE del upsert, con lo que el último en llegar
// siempre gana.
func TestALateWebhookCannotUndoACompletedRun(t *testing.T) {
	db := activityDB(t)
	repo := NewActivityRepository(db)
	at := time.Now().Truncate(time.Second)

	stored, advanced, err := repo.UpsertRun(aRun(9, 1, "requested", "", at))
	if err != nil || !advanced || stored.Status != "requested" {
		t.Fatalf("la primera escritura: %+v %v %v", stored, advanced, err)
	}
	stored, advanced, err = repo.UpsertRun(aRun(9, 1, domain.RunStatusCompleted, "success", at))
	if err != nil || !advanced || stored.Status != domain.RunStatusCompleted || stored.Conclusion != "success" {
		t.Fatalf("el completed: %+v %v %v", stored, advanced, err)
	}
	stored, advanced, err = repo.UpsertRun(aRun(9, 1, domain.RunStatusInProgress, "", at))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != domain.RunStatusCompleted || stored.Conclusion != "success" {
		t.Errorf("un in_progress tardío deshizo el completed: %+v", stored)
	}
	if advanced {
		t.Error("retroceder no es avanzar")
	}
	// Y la reentrega del mismo completed refresca los datos pero no es noticia.
	again := aRun(9, 1, domain.RunStatusCompleted, "success", at)
	again.Actor = "bea"
	stored, advanced, err = repo.UpsertRun(again)
	if err != nil {
		t.Fatal(err)
	}
	if advanced {
		t.Error("la reentrega de un completed no avanza: sonaría dos veces")
	}
	if stored.Actor != "bea" {
		t.Errorf("con el mismo rango los datos sí se refrescan: %q", stored.Actor)
	}
	var n int64
	db.Model(&domain.WorkflowRun{}).Count(&n)
	if n != 1 {
		t.Errorf("%d filas para un intento; se esperaba 1", n)
	}
}

// ─── El feed ──────────────────────────────────────────────────────────────────

// Dos servicios de la org (api en dwit/api con prod.yml, web en dwit/web sin
// workflow) y un deploy helper.
func feedFixture(t *testing.T, db *gorm.DB) {
	t.Helper()
	mk := func(v any) {
		if err := db.Create(v).Error; err != nil {
			t.Fatal(err)
		}
	}
	mk(&domain.Deployable{BaseModel: domain.BaseModel{ID: "dep-api"}, OrgID: "org-1", ServerID: "srv-1", Name: "api",
		Stack: "beta", ServiceName: "beta_app", ImageRepo: "ghcr.io/dwit/api", Environment: "prod",
		RepoFullName: "dwit/api", BuildWorkflow: "prod.yml", OnCINotify: "record"})
	mk(&domain.Deployable{BaseModel: domain.BaseModel{ID: "dep-web"}, OrgID: "org-1", ServerID: "srv-1", Name: "web",
		Stack: "beta", ServiceName: "beta_web", ImageRepo: "ghcr.io/dwit/web", Environment: "prod",
		RepoFullName: "dwit/web", OnCINotify: "record"})
}

func aDeployment(id, deployableID, runID string, at time.Time) *domain.Deployment {
	d := &domain.Deployment{OrgID: "org-1", DeployableID: deployableID, ServerID: "srv-1",
		Image: "ghcr.io/dwit/api:abc1234", RequestedBy: domain.DeployByGitHub, Status: domain.DeploySucceeded,
		WorkflowRunID: runID}
	d.ID = id
	d.CreatedAt = at
	return d
}

func kinds(items []domain.ActivityEntry) string {
	out := ""
	for _, e := range items {
		if e.Run != nil {
			out += fmt.Sprintf("run:%d ", e.Run.RunID)
		} else {
			out += "dep:" + e.Deployment.ID + " "
		}
	}
	return out
}

// Runs y deploys salen mezclados por tiempo, el más nuevo primero. El mutante
// que mata: `ORDER BY at ASC`, o mezclar sin ordenar.
func TestTheFeedMergesRunsAndDeploymentsNewestFirst(t *testing.T) {
	db := activityDB(t)
	feedFixture(t, db)
	repo := NewActivityRepository(db)
	t0 := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	for i, r := range []*domain.WorkflowRun{
		aRun(1, 1, domain.RunStatusCompleted, "success", t0),
		aRun(2, 1, domain.RunStatusCompleted, "failure", t0.Add(2*time.Minute)),
		aRun(3, 1, domain.RunStatusInProgress, "", t0.Add(4*time.Minute)),
	} {
		if _, _, err := repo.UpsertRun(r); err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
	}
	db.Create(aDeployment("d-a", "dep-api", "", t0.Add(time.Minute)))
	db.Create(aDeployment("d-b", "dep-api", "", t0.Add(3*time.Minute)))

	page, err := repo.Feed("org-1", domain.ActivityFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(page.Items); got != "run:3 dep:d-b run:2 dep:d-a run:1 " {
		t.Errorf("orden: %s", got)
	}
	for i := 1; i < len(page.Items); i++ {
		if !page.Items[i].At.Before(page.Items[i-1].At) {
			t.Errorf("la entrada %d no es más vieja que la anterior", i)
		}
	}
	if page.HasMore {
		t.Error("con cinco entradas y página de cincuenta no hay más")
	}
	if e := page.Items[1]; e.Deployment == nil || e.Deployment.DeployableName != "api" || e.Deployment.DeployableEnv != "prod" {
		t.Errorf("el deploy no trae su servicio: %+v", e.Deployment)
	}
	// Otra org no ve nada.
	other, _ := repo.Feed("org-2", domain.ActivityFilter{})
	if len(other.Items) != 0 {
		t.Errorf("otra org vio %d entradas", len(other.Items))
	}
}

// Paginar con `(at, id)` no repite ni salta ninguna entrada, aunque dos caigan
// en el mismo instante. Mutantes: `<=` en el cursor (repite la última), pedir
// `limit` en vez de `limit+1` (HasMore siempre falso), o paginar sólo por
// fecha (las dos del mismo instante se pierden o se duplican).
func TestTheCursorNeverRepeatsNorSkips(t *testing.T) {
	db := activityDB(t)
	feedFixture(t, db)
	repo := NewActivityRepository(db)
	t0 := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	// Dos runs en el mismo instante, a propósito.
	for _, r := range []*domain.WorkflowRun{
		aRun(1, 1, domain.RunStatusCompleted, "success", t0),
		aRun(2, 1, domain.RunStatusCompleted, "success", t0),
		aRun(3, 1, domain.RunStatusCompleted, "success", t0.Add(time.Minute)),
	} {
		if _, _, err := repo.UpsertRun(r); err != nil {
			t.Fatal(err)
		}
	}
	db.Create(aDeployment("d-a", "dep-api", "", t0))
	db.Create(aDeployment("d-b", "dep-api", "", t0.Add(2*time.Minute)))

	seen := map[string]int{}
	var sizes []int
	f := domain.ActivityFilter{Limit: 2}
	for round := 0; round < 5; round++ {
		page, err := repo.Feed("org-1", f)
		if err != nil {
			t.Fatal(err)
		}
		sizes = append(sizes, len(page.Items))
		for _, e := range page.Items {
			id := ""
			if e.Run != nil {
				id = e.Run.ID
			} else {
				id = e.Deployment.ID
			}
			seen[id]++
		}
		if !page.HasMore {
			break
		}
		last := page.Items[len(page.Items)-1]
		f.Before = last.At
		if last.Run != nil {
			f.BeforeID = last.Run.ID
		} else {
			f.BeforeID = last.Deployment.ID
		}
	}
	if fmt.Sprint(sizes) != "[2 2 1]" {
		t.Errorf("páginas: %v, se esperaba [2 2 1]", sizes)
	}
	if len(seen) != 5 {
		t.Errorf("se vieron %d entradas distintas de 5", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s salió %d veces", id, n)
		}
	}
}

// Por repo, salen sus runs y los deploys de los servicios de ese repo. Por
// servicio, sus deploys y los runs de su repo que son de su workflow de build;
// sin workflow puesto, todos los del repo. Mutantes: quitar la cláusula del
// `path` (el run de tests.yml saldría para api), o filtrar deploys por repo y
// no por servicio.
func TestTheFeedFiltersByRepoAndByDeployable(t *testing.T) {
	db := activityDB(t)
	feedFixture(t, db)
	repo := NewActivityRepository(db)
	t0 := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	prod := aRun(1, 1, domain.RunStatusCompleted, "success", t0)
	tests := aRun(2, 1, domain.RunStatusCompleted, "success", t0.Add(time.Minute))
	tests.Path = ".github/workflows/tests.yml"
	web := aRun(3, 1, domain.RunStatusCompleted, "success", t0.Add(2*time.Minute))
	web.RepoFullName, web.RepoID, web.Path = "dwit/web", 200, ".github/workflows/ci.yml"
	for _, r := range []*domain.WorkflowRun{prod, tests, web} {
		if _, _, err := repo.UpsertRun(r); err != nil {
			t.Fatal(err)
		}
	}
	db.Create(aDeployment("d-api", "dep-api", "", t0.Add(3*time.Minute)))
	db.Create(aDeployment("d-web", "dep-web", "", t0.Add(4*time.Minute)))

	byRepo, err := repo.Feed("org-1", domain.ActivityFilter{Repo: "DWIT/API"})
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(byRepo.Items); got != "dep:d-api run:2 run:1 " {
		t.Errorf("por repo (sin distinguir mayúsculas): %s", got)
	}
	byAPI, _ := repo.Feed("org-1", domain.ActivityFilter{DeployableID: "dep-api"})
	if got := kinds(byAPI.Items); got != "dep:d-api run:1 " {
		t.Errorf("por el servicio api (sólo su workflow): %s", got)
	}
	byWeb, _ := repo.Feed("org-1", domain.ActivityFilter{DeployableID: "dep-web"})
	if got := kinds(byWeb.Items); got != "dep:d-web run:3 " {
		t.Errorf("por el servicio web (sin workflow: todos los de su repo): %s", got)
	}
}

// Un run enseña los deploys que disparó, colgados de él, y un deploy sabe de
// qué run viene. El mutante que mata: no cargar los deploys por
// `workflow_run_id`.
func TestARunShowsTheDeploysItTriggered(t *testing.T) {
	db := activityDB(t)
	feedFixture(t, db)
	repo := NewActivityRepository(db)
	t0 := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	run, _, err := repo.UpsertRun(aRun(1, 1, domain.RunStatusCompleted, "success", t0))
	if err != nil {
		t.Fatal(err)
	}
	db.Create(aDeployment("d-1", "dep-api", run.ID, t0.Add(time.Minute)))
	db.Create(aDeployment("d-0", "dep-api", "", t0.Add(-time.Hour)))

	page, err := repo.Feed("org-1", domain.ActivityFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var entry *domain.ActivityEntry
	for i := range page.Items {
		if page.Items[i].Run != nil {
			entry = &page.Items[i]
		}
	}
	if entry == nil || len(entry.Deployments) != 1 || entry.Deployments[0].ID != "d-1" || entry.Deployments[0].DeployableName != "api" {
		t.Fatalf("el run no cuelga su deploy: %+v", entry)
	}
	if page.Items[0].Deployment == nil || page.Items[0].Deployment.WorkflowRunID != run.ID {
		t.Errorf("el deploy no dice de qué run viene: %+v", page.Items[0].Deployment)
	}
}

// Un re-run reutiliza el id del run y sube el intento: es otra fila, no una
// sobreescritura del primero. El mutante que mata: índice único sólo por
// `run_id`.
func TestARerunIsItsOwnRow(t *testing.T) {
	db := activityDB(t)
	repo := NewActivityRepository(db)
	at := time.Now()
	if _, _, err := repo.UpsertRun(aRun(9, 1, domain.RunStatusCompleted, "failure", at)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repo.UpsertRun(aRun(9, 2, domain.RunStatusCompleted, "success", at.Add(time.Minute))); err != nil {
		t.Fatal(err)
	}
	var rows []domain.WorkflowRun
	db.Order("run_attempt").Find(&rows)
	if len(rows) != 2 || rows[0].Conclusion != "failure" || rows[1].Conclusion != "success" {
		t.Fatalf("se esperaban dos intentos, el primero fallado y el segundo bien: %+v", rows)
	}
}
