package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
Dar de alta por correo y restablecer la contraseña (19-oct-2026).

Un admin de una organización da de alta a alguien con su nombre y su correo; le
llega un enlace de un solo uso y en la web elige su usuario y su contraseña. El
admin nunca sabe una contraseña que funcione. Si el correo ya tiene cuenta, no
se duplica: se le invita como siempre.

Sobre una base desechable: ana (admin de org-1, lee en castellano) y bea (otra
cuenta, sin organización).
*/

const (
	anaID = "11111111-1111-4111-8111-111111111111"
	beaID = "22222222-2222-4222-8222-222222222222"
)

// buzon guarda lo que se mandó, y puede fallar como SES.
type buzon struct {
	mu   sync.Mutex
	sent []domain.Email
	err  error
}

func (b *buzon) Send(_ context.Context, e domain.Email) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return b.err
	}
	b.sent = append(b.sent, e)
	return nil
}

func (b *buzon) last(t *testing.T) domain.Email {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.sent) == 0 {
		t.Fatal("no salió ningún correo")
	}
	return b.sent[len(b.sent)-1]
}

// tokenOf: el token del enlace de un correo (lo que va detrás del `#`).
func tokenOf(t *testing.T, e domain.Email, path string) string {
	t.Helper()
	marca := "https://cac.test" + path + "#"
	i := strings.Index(e.Text, marca)
	if i < 0 {
		t.Fatalf("el correo no lleva el enlace a %s:\n%s", path, e.Text)
	}
	rest := e.Text[i+len(marca):]
	if j := strings.IndexAny(rest, "\n "); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

type accountFixture struct {
	db   *gorm.DB
	svc  *AccountService
	auth *AuthService
	mail *buzon
	now  time.Time
}

func accountSetup(t *testing.T, mail Mailer) *accountFixture {
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
	// Un nombre por base: una prueba puede montar dos (con y sin correo).
	name := fmt.Sprintf("cac_test_accounts_%d", time.Now().UnixNano())
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Fatalf("DB_HOST is set but a throwaway database cannot be created: %v", err)
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
	ana, _ := repository.HashPassword("ana-de-siempre")
	for _, q := range []*gorm.DB{
		db.Exec(`INSERT INTO users (id, username, email, name, password, locale, created_at, updated_at) VALUES
			(?,'ana','ana@x.io','Ana',?,'es',?,?), (?,'bea','bea@x.io','Bea','x','',?,?)`,
			anaID, ana, now, now, beaID, now, now),
		db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org-1','Uno','uno',?,?), ('org-2','Dos','dos',?,?)`, now, now, now, now),
		db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES ('org-1',?,'admin',?)`, anaID, now),
	} {
		if q.Error != nil {
			t.Fatalf("la fixture no se pudo insertar: %v", q.Error)
		}
	}

	f := &accountFixture{db: db, now: now}
	users := repository.NewAuthRepository(db)
	f.auth = NewAuthService(users)
	var m Mailer
	if b, ok := mail.(*buzon); ok {
		f.mail = b
		m = b
	} else if mail != nil {
		m = mail
	}
	f.svc = NewAccountService(repository.NewAccountRepository(db), users, repository.NewOrganizationRepository(db),
		NewInvitationService(repository.NewInvitationRepository(db)), f.auth, m, "https://cac.test/").Sync()
	f.svc.now = func() time.Time { return f.now }
	return f
}

func (f *accountFixture) user(t *testing.T, where string, args ...any) domain.User {
	t.Helper()
	var u domain.User
	if err := f.db.Where(where, args...).First(&u).Error; err != nil {
		t.Fatalf("no se encontró la cuenta (%s): %v", where, err)
	}
	return u
}

func (f *accountFixture) create(t *testing.T, email string) *domain.CreateAccountResponse {
	t.Helper()
	out, err := f.svc.CreateForOrg(context.Background(), "org-1", anaID, "",
		domain.CreateAccountRequest{Name: " Caro ", Email: email, Role: domain.OrgRoleMember})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Una cuenta nueva nace pendiente y ya miembro, y no entra; le llega el
// enlace en el idioma del admin (la persona no ha elegido el suyo), y el
// admin no recibe el enlace si el correo salió. Mutantes: crearla sin
// pendiente; sin membresía; sin normalizar el correo; dar el enlace al admin
// aunque el correo salió; escribir en el idioma de la petición y no en el del
// admin.
func TestANewAccountIsPendingAndGetsItsLinkByEmail(t *testing.T) {
	f := accountSetup(t, &buzon{})
	out := f.create(t, "  Caro@X.io ")
	if out.Status != domain.AccountCreated || !out.EmailSent || out.Link != "" {
		t.Fatalf("la respuesta: %+v", out)
	}
	u := f.user(t, "id = ?", out.UserID)
	if !u.SetupPending || u.Email != "caro@x.io" || u.Name != "Caro" {
		t.Fatalf("la cuenta: %+v", u)
	}
	var m domain.OrgMembership
	if err := f.db.Where("org_id = 'org-1' AND user_id = ?", u.ID).First(&m).Error; err != nil || m.Role != domain.OrgRoleMember {
		t.Fatalf("no quedó como miembro: %v %+v", err, m)
	}
	e := f.mail.last(t)
	if e.To != "caro@x.io" || !strings.Contains(e.Subject, "Ana te creó una cuenta de cac en Uno") {
		t.Fatalf("el correo: %s · %s", e.To, e.Subject)
	}
	if !strings.Contains(e.HTML, "/app/welcome#") || tokenOf(t, e, "/app/welcome") == "" {
		t.Fatal("el correo no lleva el enlace")
	}
	// No entra, y no porque su contraseña sea un secreto: ni sabiéndola.
	known, _ := repository.HashPassword("la-sabemos-8")
	f.db.Model(&domain.User{}).Where("id = ?", u.ID).Update("password", known)
	if _, err := f.auth.Login(domain.LoginRequest{Username: u.Username, Password: "la-sabemos-8"}); err == nil {
		t.Fatal("una cuenta pendiente entró")
	}
}

// Sin correo, o si SES lo rechaza, el alta no se pierde: el admin recibe el
// enlace para pasarlo a mano. Mutante: no darle el enlace.
func TestWithoutEmailTheAdminGetsTheLink(t *testing.T) {
	f := accountSetup(t, nil)
	out := f.create(t, "caro@x.io")
	if out.EmailSent || !strings.HasPrefix(out.Link, "https://cac.test/app/welcome#") {
		t.Fatalf("sin correo: %+v", out)
	}

	g := accountSetup(t, &buzon{err: errors.New("MessageRejected")})
	out = g.create(t, "dani@x.io")
	if out.EmailSent || out.Link == "" {
		t.Fatalf("con SES rechazando: %+v", out)
	}
}

// Un correo que ya tiene cuenta no se duplica: se le invita (la acepta dentro
// de la app) y se le avisa. Mutante: buscar el correo sin normalizar, que
// crea una segunda cuenta para la misma persona.
func TestAnExistingEmailIsInvitedNotDuplicated(t *testing.T) {
	f := accountSetup(t, &buzon{})
	out := f.create(t, " BEA@x.io")
	if out.Status != domain.AccountInvited || out.UserID != beaID {
		t.Fatalf("la respuesta: %+v", out)
	}
	var n int64
	f.db.Model(&domain.User{}).Where("lower(email) = 'bea@x.io'").Count(&n)
	if n != 1 {
		t.Fatalf("hay %d cuentas con ese correo", n)
	}
	var inv domain.OrgInvitation
	if err := f.db.Where("org_id = 'org-1' AND invited_user_id = ?", beaID).First(&inv).Error; err != nil || inv.Status != domain.InvitePending {
		t.Fatalf("la invitación: %v %+v", err, inv)
	}
	if e := f.mail.last(t); e.To != "bea@x.io" || strings.Contains(e.Text, "#") {
		t.Fatalf("el aviso no es un enlace de cuenta: %s\n%s", e.To, e.Text)
	}
	// Y la base tampoco deja dos cuentas con el mismo correo, aunque la
	// comprobación de arriba se la salten dos altas a la vez.
	err := repository.NewAccountRepository(f.db).CreatePendingMember(
		&domain.User{BaseModel: domain.BaseModel{ID: "33333333-3333-4333-8333-333333333333"}, Username: "otra", Password: "x", Email: "Bea@X.io"},
		"org-1", domain.OrgRoleMember)
	if !errors.Is(err, repository.ErrEmailTaken) {
		t.Fatalf("el mismo correo otra vez → %v", err)
	}
}

// El enlace de bienvenida elige usuario y contraseña, una sola vez, y deja
// entrar con ellos. Un usuario ocupado no gasta el enlace. Mutantes: no
// marcar el enlace como usado; gastarlo aunque el usuario esté ocupado; no
// pasar el usuario a minúsculas; no quitar el pendiente.
func TestTheWelcomeLinkSetsUsernameAndPasswordOnce(t *testing.T) {
	f := accountSetup(t, &buzon{})
	out := f.create(t, "caro@x.io")
	token := tokenOf(t, f.mail.last(t), "/app/welcome")

	info, err := f.svc.InspectLink(token)
	if err != nil || info.Purpose != domain.LinkWelcome || info.Email != "caro@x.io" || info.OrgName != "Uno" {
		t.Fatalf("lo que se enseña: %v %+v", err, info)
	}
	if _, err := f.svc.CompleteWelcome(domain.CompleteWelcomeRequest{Token: token, Username: "Ana", Password: "una-buena-8"}); !errors.Is(err, repository.ErrUsernameTaken) {
		t.Fatalf("un usuario ocupado → %v", err)
	}
	if _, err := f.svc.CompleteWelcome(domain.CompleteWelcomeRequest{Token: token, Username: "c a r o", Password: "una-buena-8"}); !errors.Is(err, ErrBadUsername) {
		t.Fatalf("un usuario con espacios → %v", err)
	}
	session, err := f.svc.CompleteWelcome(domain.CompleteWelcomeRequest{Token: token, Username: " Caro.G ", Password: "una-buena-8", Client: "web"})
	if err != nil || session.AccessToken == "" || session.Session.Username != "caro.g" {
		t.Fatalf("terminar el registro: %v %+v", err, session)
	}
	if u := f.user(t, "id = ?", out.UserID); u.SetupPending || u.Username != "caro.g" {
		t.Fatalf("la cuenta después: %+v", u)
	}
	if _, err := f.auth.Login(domain.LoginRequest{Username: "caro.g", Password: "una-buena-8"}); err != nil {
		t.Fatalf("no entra con lo que eligió: %v", err)
	}
	if _, err := f.svc.CompleteWelcome(domain.CompleteWelcomeRequest{Token: token, Username: "otro", Password: "otra-buena-8"}); !errors.Is(err, repository.ErrLinkInvalid) {
		t.Fatalf("el mismo enlace dos veces → %v", err)
	}
}

// Reenviar deja vivo sólo el último enlace, y uno caducado no vale.
// Mutantes: no dar por usados los anteriores; no mirar la caducidad.
func TestOnlyTheLastLinkWorksAndNotForever(t *testing.T) {
	f := accountSetup(t, &buzon{})
	out := f.create(t, "caro@x.io")
	first := tokenOf(t, f.mail.last(t), "/app/welcome")
	if _, err := f.svc.ResendWelcome(context.Background(), "org-1", out.UserID, anaID, ""); err != nil {
		t.Fatal(err)
	}
	second := tokenOf(t, f.mail.last(t), "/app/welcome")
	if _, err := f.svc.InspectLink(first); !errors.Is(err, repository.ErrLinkInvalid) {
		t.Fatalf("el enlace anterior sigue valiendo: %v", err)
	}
	if _, err := f.svc.InspectLink(second); err != nil {
		t.Fatalf("el nuevo no vale: %v", err)
	}
	f.now = f.now.Add(8 * 24 * time.Hour)
	if _, err := f.svc.CompleteWelcome(domain.CompleteWelcomeRequest{Token: second, Username: "caro", Password: "una-buena-8"}); !errors.Is(err, repository.ErrLinkInvalid) {
		t.Fatalf("un enlace de hace 8 días → %v", err)
	}
	// Y a quien ya terminó no se le reenvía bienvenida.
	if _, err := f.svc.ResendWelcome(context.Background(), "org-1", anaID, anaID, ""); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("reenviar a una cuenta hecha → %v", err)
	}
}

// Olvidé mi contraseña: contesta igual exista o no la cuenta, manda el enlace
// sólo a quien lo tiene (por usuario o por correo), en su idioma; el enlace
// cambia la contraseña una vez, cierra las sesiones de antes y vale una hora.
// Mutantes: avisar de que no existe; mandar a una cuenta pendiente; no cerrar
// las sesiones; no mirar la hora.
func TestAForgottenPasswordIsResetByEmail(t *testing.T) {
	f := accountSetup(t, &buzon{})
	if err := f.svc.ForgotPassword(context.Background(), "nadie", ""); err != nil {
		t.Fatalf("una cuenta que no existe → %v", err)
	}
	pending := f.create(t, "caro@x.io")
	before := len(f.mail.sent)
	if err := f.svc.ForgotPassword(context.Background(), "caro@x.io", ""); err != nil {
		t.Fatal(err)
	}
	if len(f.mail.sent) != before {
		t.Fatalf("a una cuenta pendiente (%s) le llegó un enlace para restablecer", pending.UserID)
	}

	old, err := f.auth.Login(domain.LoginRequest{Username: "ana", Password: "ana-de-siempre"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.ForgotPassword(context.Background(), " ANA@x.io ", "en"); err != nil {
		t.Fatal(err)
	}
	e := f.mail.last(t)
	if e.To != "ana@x.io" || !strings.Contains(e.Subject, "Restablece tu contraseña") {
		t.Fatalf("el correo (ana lee en castellano): %s · %s", e.To, e.Subject)
	}
	token := tokenOf(t, e, "/app/reset-password")
	if _, err := f.svc.ResetPassword(domain.ResetPasswordRequest{Token: token, Password: "nueva-de-ana"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth.Login(domain.LoginRequest{Username: "ana", Password: "nueva-de-ana"}); err != nil {
		t.Fatalf("no entra con la nueva: %v", err)
	}
	if _, err := f.auth.RefreshToken(old.RefreshToken); err == nil {
		t.Fatal("la sesión de antes de restablecer sigue viva")
	}
	if _, err := f.svc.ResetPassword(domain.ResetPasswordRequest{Token: token, Password: "otra-vez-8"}); !errors.Is(err, repository.ErrLinkInvalid) {
		t.Fatalf("el mismo enlace dos veces → %v", err)
	}

	if err := f.svc.ForgotPassword(context.Background(), "ana", ""); err != nil {
		t.Fatal(err)
	}
	late := tokenOf(t, f.mail.last(t), "/app/reset-password")
	f.now = f.now.Add(61 * time.Minute)
	if _, err := f.svc.ResetPassword(domain.ResetPasswordRequest{Token: late, Password: "tarde-ya-8"}); !errors.Is(err, repository.ErrLinkInvalid) {
		t.Fatalf("un enlace de hace una hora → %v", err)
	}
}

// Sin correo configurado, restablecer lo dice: no hay otra forma de que
// llegue el enlace.
func TestWithoutEmailThereIsNoReset(t *testing.T) {
	f := accountSetup(t, nil)
	if err := f.svc.ForgotPassword(context.Background(), "ana", ""); !errors.Is(err, ErrMailOff) {
		t.Fatalf("sin correo → %v", err)
	}
}

// Alguien que otra org dio de alta y no terminó el registro no se invita
// (no podría entrar a aceptar): pasa a ser miembro también y le llega la
// bienvenida otra vez, con un enlace nuevo que anula el anterior. Rotura que
// detecta: tratar la cuenta pendiente como una cuenta hecha.
func TestAPendingAccountIsWelcomedAgainNotInvited(t *testing.T) {
	f := accountSetup(t, &buzon{})
	first := f.create(t, "caro@x.io")
	oldToken := tokenOf(t, f.mail.last(t), "/app/welcome")
	out, err := f.svc.CreateForOrg(context.Background(), "org-2", beaID, "",
		domain.CreateAccountRequest{Name: "Caro", Email: "CARO@x.io", Role: domain.OrgRoleViewer})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != domain.AccountCreated || out.UserID != first.UserID || !out.EmailSent {
		t.Fatalf("la respuesta: %+v", out)
	}
	var invites, members int64
	f.db.Model(&domain.OrgInvitation{}).Where("invited_user_id = ?", first.UserID).Count(&invites)
	f.db.Model(&domain.OrgMembership{}).Where("user_id = ?", first.UserID).Count(&members)
	if invites != 0 || members != 2 {
		t.Fatalf("invitaciones %d (0), membresías %d (2)", invites, members)
	}
	if _, err := f.svc.InspectLink(oldToken); !errors.Is(err, repository.ErrLinkInvalid) {
		t.Fatalf("el enlace de la primera bienvenida sigue valiendo: %v", err)
	}
	if _, err := f.svc.InspectLink(tokenOf(t, f.mail.last(t), "/app/welcome")); err != nil {
		t.Fatalf("el nuevo no vale: %v", err)
	}
}
