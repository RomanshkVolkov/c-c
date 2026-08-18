package service

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Quién está en un espacio y cuánto queda por hacer en él.
//
// Un espacio no tiene tabla de miembros —quien pertenece a la organización
// llega a todos— así que «quién está aquí» sólo se puede responder por quién
// carga trabajo. Y las tareas se cuentan dos veces, todas y las que quedan,
// porque «9 de 48» dice algo que ninguna de las dos cifras dice sola.

func TestElEspacioDiceQuienCargaTrabajoEnEl(t *testing.T) {
	db, cleanup := arbolDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)

	arbol, err := repo.Tree([]string{"org-1"}, false, "org-1")
	if err != nil {
		t.Fatal(err)
	}
	por := map[string]domain.SpaceTree{}
	for _, sp := range arbol {
		por[sp.ID] = sp
	}

	caras := map[string]bool{}
	for _, p := range por["esp-a"].People {
		caras[p.Username] = true
	}
	if !caras["ana"] || !caras["bea"] {
		t.Errorf("ana y bea cargan trabajo en esp-a, salieron %+v", por["esp-a"].People)
	}
	// Quien sólo tiene cosas terminadas ya no está sosteniendo nada.
	if caras["caro"] {
		t.Error("caro sólo tiene tareas cerradas: no debería contar como que está en el espacio")
	}
	// Y un espacio donde nadie carga nada sale vacío, no nulo: la ficha itera.
	if por["esp-b"].People == nil {
		t.Error("un espacio sin gente debe traer una lista vacía, no null")
	}
	if len(por["esp-b"].People) != 0 {
		t.Errorf("nadie tiene trabajo abierto en esp-b, salieron %+v", por["esp-b"].People)
	}
}

func TestLaListaDiceCuantasHayYCuantasQuedan(t *testing.T) {
	db, cleanup := arbolDB(t)
	defer cleanup()
	repo := repository.NewTaskRepository(db)

	arbol, _ := repo.Tree([]string{"org-1"}, false, "org-1")
	var lista *domain.ListSummary
	for _, sp := range arbol {
		for i := range sp.Lists {
			if sp.Lists[i].ID == "lis-a" {
				lista = &sp.Lists[i]
			}
		}
	}
	if lista == nil {
		t.Fatal("no salió lis-a")
	}
	// Cuatro vivas: tres abiertas y una cerrada. La archivada no cuenta en
	// ninguna de las dos.
	if lista.TaskCount != 4 {
		t.Errorf("todas las vivas son cuatro, salieron %d", lista.TaskCount)
	}
	if lista.OpenCount != 3 {
		t.Errorf("quedan tres por hacer, salieron %d", lista.OpenCount)
	}
}

func arbolDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_arbol"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.TaskSpace{}, &domain.TaskFolder{},
		&domain.TaskList{}, &domain.Item{}); err != nil {
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
		('u-ana','ana','a@x.io','x',?,?), ('u-bea','bea','b@x.io','x',?,?),
		('u-caro','caro','c@x.io','x',?,?)`, ahora, ahora, ahora, ahora, ahora, ahora))
	must(db.Exec(`INSERT INTO task_spaces (id, org_id, name, color, rank, created_at, updated_at) VALUES
		('esp-a','org-1','Uno','#fff','m',?,?), ('esp-b','org-1','Dos','#fff','n',?,?)`, ahora, ahora, ahora, ahora))
	must(db.Exec(`INSERT INTO task_lists (id, space_id, name, rank, created_at, updated_at) VALUES
		('lis-a','esp-a','L','m',?,?), ('lis-b','esp-b','M','m',?,?)`, ahora, ahora, ahora, ahora))

	ins := func(id, lista, estado string, quien *string, archivada bool) {
		var arch any
		if archivada {
			arch = ahora
		}
		must(db.Exec(`INSERT INTO items (id, list_id, org_id, title, status, origin, assignee_user_id, archived_at, created_at, updated_at)
			VALUES (?, ?, 'org-1', 't', ?, 'internal', ?, ?, ?, ?)`, id, lista, estado, quien, arch, ahora, ahora))
	}
	ana, bea, caro := "u-ana", "u-bea", "u-caro"
	ins("t-1", "lis-a", "pending", &ana, false)
	ins("t-2", "lis-a", "in_progress", &bea, false)
	ins("t-3", "lis-a", "pending", nil, false) // sin responsable
	ins("t-4", "lis-a", "closed", &caro, false)
	ins("t-5", "lis-a", "pending", &ana, true) // archivada: no cuenta
	ins("t-6", "lis-b", "closed", &caro, false)

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
