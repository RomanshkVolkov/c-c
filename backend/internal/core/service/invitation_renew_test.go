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

// Una invitación que caducó sigue viéndose desde la organización, y se puede
// revivir.
//
// Antes la lista de administración escondía las vencidas igual que la del
// invitado. El efecto era que la única salida ante una invitación caducada era
// retirarla —que tampoco se podía, porque no aparecía— o crear otra, que
// chocaba con la guarda de «ya hay una pendiente». Quien administra tiene que
// verlas; quien recibe, no, porque para él ya no es accionable.

func TestLaListaDeLaOrganizacionMuestraLasCaducadas(t *testing.T) {
	db, cleanup := invitesDB(t)
	defer cleanup()
	repo := repository.NewInvitationRepository(db)

	invs, err := repo.ListForOrg("org-1")
	if err != nil {
		t.Fatal(err)
	}
	vistas := map[string]bool{}
	for _, i := range invs {
		vistas[i.ID] = true
	}
	if !vistas["inv-vencida"] {
		t.Error("quien administra tiene que ver la invitación vencida para poder actuar sobre ella")
	}
	if !vistas["inv-viva"] {
		t.Error("la vigente debe seguir apareciendo")
	}
	// Y con su fecha, que es lo único con lo que la pantalla puede distinguirlas.
	for _, i := range invs {
		if i.ExpiresAt.IsZero() {
			t.Errorf("la respuesta debe traer el vencimiento, %s vino en cero", i.ID)
		}
	}
}

// Al invitado, en cambio, una vencida no se le ofrece: aceptarla ya falla.
func TestAlInvitadoNoSeLeOfreceUnaVencida(t *testing.T) {
	db, cleanup := invitesDB(t)
	defer cleanup()
	repo := repository.NewInvitationRepository(db)

	invs, err := repo.ListForUser("u-bea")
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range invs {
		if i.ID == "inv-vencida" {
			t.Error("una invitación caducada no es accionable para quien la recibe")
		}
	}
}

// Reenviar devuelve el plazo, y aceptar vuelve a funcionar.
func TestReenviarDevuelveLaVigencia(t *testing.T) {
	db, cleanup := invitesDB(t)
	defer cleanup()
	svc := NewInvitationService(repository.NewInvitationRepository(db))

	if err := svc.Accept("inv-vencida", "u-bea"); err == nil {
		t.Fatal("aceptar una vencida debe fallar antes de renovarla; si no, el test no prueba nada")
	}
	if err := svc.Renew("inv-vencida", "org-1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Accept("inv-vencida", "u-bea"); err != nil {
		t.Errorf("tras reenviarla debe poder aceptarse: %v", err)
	}
}

// El id de la organización de la URL manda: no se renueva la invitación de otra.
func TestNoSeRenuevaLaInvitacionDeOtraOrganizacion(t *testing.T) {
	db, cleanup := invitesDB(t)
	defer cleanup()
	svc := NewInvitationService(repository.NewInvitationRepository(db))

	if err := svc.Renew("inv-vencida", "org-ajena"); err == nil {
		t.Error("renovar desde otra organización debe rechazarse")
	}
	// Y no la tocó: sigue caducada.
	var inv domain.OrgInvitation
	db.First(&inv, "id = ?", "inv-vencida")
	if inv.ExpiresAt.After(time.Now()) {
		t.Error("el rechazo no debe haber empujado el vencimiento")
	}
}

// Una invitación ya retirada no revive por reenviarla: quien la cerró la cerró.
func TestReenviarNoResucitaUnaRetirada(t *testing.T) {
	db, cleanup := invitesDB(t)
	defer cleanup()
	svc := NewInvitationService(repository.NewInvitationRepository(db))

	if err := svc.Renew("inv-retirada", "org-1"); err == nil {
		t.Error("reenviar una retirada debe fallar, no devolverle vida")
	}
	var inv domain.OrgInvitation
	db.First(&inv, "id = ?", "inv-retirada")
	if inv.Status != domain.InviteRevoked {
		t.Errorf("debe seguir retirada, quedó %q", inv.Status)
	}
}

func invitesDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_invites"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.Organization{}, &domain.OrgMembership{}, &domain.OrgInvitation{}); err != nil {
		t.Fatal(err)
	}
	ahora := time.Now()
	db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at) VALUES
		('u-ana','ana','ana@x.io','x',$1,$1), ('u-bea','bea','bea@x.io','x',$1,$1)`, ahora)
	db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES
		('org-1','Uno','uno',$1,$1), ('org-ajena','Otra','otra',$1,$1)`, ahora)
	db.Exec(`INSERT INTO org_invitations (id, org_id, invited_user_id, role, invited_by_user_id, status, expires_at, created_at, updated_at) VALUES
		('inv-viva','org-1','u-bea','member','u-ana','pending',$2,$1,$1),
		('inv-vencida','org-1','u-bea','member','u-ana','pending',$3,$1,$1),
		('inv-retirada','org-1','u-bea','member','u-ana','revoked',$3,$1,$1)`,
		ahora, ahora.Add(72*time.Hour), ahora.Add(-72*time.Hour))

	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}
