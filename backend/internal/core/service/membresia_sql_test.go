package service

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Que te añadan a una organización te llega **a ti**.
//
// Es lo único nuevo de este arreglo, y lo que hacía que no se resolviera antes:
// el hub reparte por organización, y quien acaba de ser añadido todavía no la
// está escuchando —su token dice que no pertenece—, así que un evento dirigido a
// la organización llega a todos menos a la única persona a quien le importa.
//
// El reparto dirigido ya está probado en el paquete `events`. Lo que se prueba
// aquí es que el servicio lo use: que ponga la persona y no la organización.
func membresiaDB(t *testing.T) (*gorm.DB, func()) {
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
	const name = "cac_test_membresia"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.User{}, &domain.Organization{}, &domain.OrgMembership{}); err != nil {
		t.Fatal(err)
	}
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	}
}

func TestAvisoDePertenencia(t *testing.T) {
	db, cerrar := membresiaDB(t)
	defer cerrar()

	ahora := time.Now()
	for _, id := range []string{"admin", "ana", "bea"} {
		if err := db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at)
			VALUES (?, ?, ?, 'x', ?, ?)`, id, id, id+"@x.io", ahora, ahora).Error; err != nil {
			t.Fatal(err)
		}
	}
	org := &domain.Organization{Name: "Portento", Slug: "portento"}
	org.ID = "org-1"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.OrgMembership{OrgID: "org-1", UserID: "admin", Role: domain.OrgRoleAdmin}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.OrgMembership{OrgID: "org-1", UserID: "bea", Role: domain.OrgRoleMember}).Error; err != nil {
		t.Fatal(err)
	}
	// Ana ya es de la gente de admin, en otra org suya: sin eso, meterla sin
	// que acepte pide invitación (ver TestStrangersAreInvitedNotAdded).
	otra := &domain.Organization{Name: "Taller", Slug: "taller"}
	otra.ID = "org-2"
	if err := db.Create(otra).Error; err != nil {
		t.Fatal(err)
	}
	for _, m := range []domain.OrgMembership{{OrgID: "org-2", UserID: "admin", Role: domain.OrgRoleAdmin}, {OrgID: "org-2", UserID: "ana", Role: domain.OrgRoleMember}} {
		if err := db.Create(&m).Error; err != nil {
			t.Fatal(err)
		}
	}

	hub := events.NewHub()
	svc := NewOrganizationService(repository.NewOrganizationRepository(db)).WithHub(hub)

	// Ana **no** escucha org-1: eso es exactamente el problema.
	deAna, cerrarAna := hub.Subscribe("ana", nil)
	defer cerrarAna()
	deBea, cerrarBea := hub.Subscribe("bea", []string{"org-1"})
	defer cerrarBea()

	recibe := func(ch <-chan events.Event) *events.Event {
		select {
		case e := <-ch:
			return &e
		case <-time.After(300 * time.Millisecond):
			return nil
		}
	}

	t.Run("añadir le llega a quien entra, y a nadie más", func(t *testing.T) {
		if err := svc.AddMember("admin", "org-1",
			domain.AddMemberRequest{UserID: "ana", Role: domain.OrgRoleMember}, false); err != nil {
			t.Fatal(err)
		}
		e := recibe(deAna)
		if e == nil || e.Type != "org:membership" {
			t.Fatal("no le llegó a quien acaba de entrar, que es el fallo entero")
		}
		datos, _ := e.Data.(map[string]any)
		// El nombre viaja dentro porque quien lo recibe **no puede
		// consultarlo**: al entrar todavía no tiene permiso para leer esa
		// organización. Un aviso que dice «te han añadido a algo» no es un aviso.
		if datos["orgName"] != "Portento" {
			t.Fatalf("sin el nombre no hay nada que enseñar: %v", datos)
		}
		if datos["joined"] != true {
			t.Fatalf("entrar y salir tienen que distinguirse: %v", datos)
		}
		if e := recibe(deBea); e != nil {
			t.Fatal("le llegó a otro miembro: esto es asunto de una persona")
		}
	})

	// El mismo mecanismo al revés, y peor si falla: seguirías viendo una
	// organización a la que ya no perteneces, con cada petición dando error sin
	// explicar por qué.
	t.Run("quitar también avisa, y dice que sales", func(t *testing.T) {
		if err := svc.RemoveMember("admin", "org-1", "ana", false); err != nil {
			t.Fatal(err)
		}
		e := recibe(deAna)
		if e == nil {
			t.Fatal("salir sin enterarte deja la app enseñando algo que ya no es tuyo")
		}
		datos, _ := e.Data.(map[string]any)
		if datos["joined"] != false {
			t.Fatalf("se anunció como una entrada: %v", datos)
		}
	})
}

// Meter a alguien sin que acepte, sólo si ya es de tu gente. Cualquiera puede
// crearse una org: si bastara con ser su admin, cualquiera podría meter a
// cualquiera en la suya. Mutantes: quitar la guarda; contar como «tu gente» a
// alguien de una org donde no eres admin; pedir invitación también para
// cambiar el rol de quien ya está.
func TestStrangersAreInvitedNotAdded(t *testing.T) {
	db, cerrar := membresiaDB(t)
	defer cerrar()
	ahora := time.Now()
	for _, id := range []string{"eva", "ana", "bea", "dan"} {
		if err := db.Exec(`INSERT INTO users (id, username, email, password, created_at, updated_at)
			VALUES (?, ?, ?, 'x', ?, ?)`, id, id, id+"@x.io", ahora, ahora).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, o := range []string{"propia", "taller", "ajena"} {
		org := &domain.Organization{Name: o, Slug: o}
		org.ID = o
		if err := db.Create(org).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, m := range []domain.OrgMembership{
		{OrgID: "propia", UserID: "eva", Role: domain.OrgRoleAdmin},
		{OrgID: "propia", UserID: "bea", Role: domain.OrgRoleViewer},
		{OrgID: "taller", UserID: "eva", Role: domain.OrgRoleAdmin},
		{OrgID: "taller", UserID: "ana", Role: domain.OrgRoleMember},
		{OrgID: "ajena", UserID: "eva", Role: domain.OrgRoleMember},
		{OrgID: "ajena", UserID: "dan", Role: domain.OrgRoleMember},
	} {
		if err := db.Create(&m).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := NewOrganizationService(repository.NewOrganizationRepository(db))
	meter := func(quien string, rol domain.OrgRole) error {
		return svc.AddMember("eva", "propia", domain.AddMemberRequest{UserID: quien, Role: rol}, false)
	}
	if err := meter("dan", domain.OrgRoleMember); !errors.Is(err, ErrInviteRequired) {
		t.Errorf("alguien de una org donde eva sólo es miembro → %v, se esperaba invitarlo", err)
	}
	if err := meter("ana", domain.OrgRoleMember); err != nil {
		t.Errorf("alguien de otra org que eva administra → %v", err)
	}
	if err := meter("bea", domain.OrgRoleMember); err != nil {
		t.Errorf("cambiar el rol de quien ya está → %v", err)
	}
	if err := svc.AddMember("root", "propia", domain.AddMemberRequest{UserID: "dan", Role: domain.OrgRoleMember}, true); err != nil {
		t.Errorf("un superadmin → %v", err)
	}
}
