package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/i18n"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"gorm.io/gorm"
)

// Mailer manda un correo. Lo pone el adaptador de SES; sin él, el alta da el
// enlace al admin para que se lo pase a mano, y restablecer no está.
type Mailer interface {
	Send(ctx context.Context, e domain.Email) error
}

var (
	ErrMailOff         = errors.New("email-off")
	ErrBadUsername     = errors.New("bad-username")
	ErrAccountNotFound = errors.New("account-not-pending")
)

const (
	// Una semana: quien recibe la bienvenida no siempre la abre el mismo día.
	welcomeTTL = 7 * 24 * time.Hour
	// Una hora: un enlace para cambiar la contraseña de alguien es una llave.
	resetTTL = time.Hour
)

// usernamePattern: lo que puede elegir alguien como usuario. En minúsculas,
// porque se compara tal cual al entrar y «Ana» y «ana» serían dos.
var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,39}$`)

// AccountService da de alta por correo y restablece contraseñas. Ver
// domain/account.go.
type AccountService struct {
	accounts *repository.AccountRepository
	users    *repository.AuthRepository
	orgs     *repository.OrganizationRepository
	invites  *InvitationService
	auth     *AuthService
	mail     Mailer
	// publicURL: donde vive la web (`https://cac.guz-studio.dev`). Los enlaces
	// van a `/app/welcome#token` y `/app/reset-password#token`: el token detrás
	// del `#` no llega a ningún servidor ni a sus logs.
	publicURL string
	now       func() time.Time
	// async: restablecer manda el correo aparte, para que la respuesta tarde lo
	// mismo exista o no la cuenta. Las pruebas lo apagan para ver el correo.
	async bool
}

func NewAccountService(accounts *repository.AccountRepository, users *repository.AuthRepository,
	orgs *repository.OrganizationRepository, invites *InvitationService, auth *AuthService,
	mail Mailer, publicURL string) *AccountService {
	return &AccountService{
		accounts: accounts, users: users, orgs: orgs, invites: invites, auth: auth,
		mail: mail, publicURL: strings.TrimRight(publicURL, "/"), now: time.Now, async: true,
	}
}

// Sync manda los correos en el mismo hilo. Sólo para las pruebas.
func (s *AccountService) Sync() *AccountService {
	s.async = false
	return s
}

// CreateForOrg da de alta a alguien en una organización por su correo.
//
// Si el correo ya tiene cuenta, no se crea otra: se le invita como siempre (la
// acepta dentro de la app) y se le avisa por correo. Si no, se crea pendiente,
// ya miembro, y le llega el enlace para elegir su usuario y su contraseña.
// `lang` es la cabecera Accept-Language, por si el admin no eligió idioma.
func (s *AccountService) CreateForOrg(ctx context.Context, orgID, inviterID, lang string, req domain.CreateAccountRequest) (*domain.CreateAccountResponse, error) {
	org, err := s.orgs.FindByID(orgID)
	if err != nil {
		return nil, err
	}
	inviter, err := s.users.FindByID(inviterID)
	if err != nil {
		return nil, err
	}
	email := repository.NormalizeEmail(req.Email)
	args := map[string]string{"inviter": displayName(inviter), "org": org.Name}

	existing, err := s.accounts.FindByEmail(email)
	if err == nil {
		if err := s.invites.Create(orgID, existing.ID, inviterID, req.Role); err != nil {
			return nil, err
		}
		l := emailLocale(existing.Locale, lang)
		args["name"] = displayName(existing)
		sent := s.send(ctx, renderEmail(l, existing.Email, mailInvited, args, s.publicURL+"/app/"))
		return &domain.CreateAccountResponse{Status: domain.AccountInvited, UserID: existing.ID, EmailSent: sent}, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	// Un usuario y una contraseña que nadie sabe, hasta que elija los suyos.
	secret, err := randomSecret()
	if err != nil {
		return nil, err
	}
	hashed, err := repository.HashPassword(secret)
	if err != nil {
		return nil, err
	}
	u := &domain.User{
		Username: "pending-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12],
		Password: hashed, Email: email, Name: strings.TrimSpace(req.Name), SetupPending: true,
	}
	u.ID = uuid.NewString()
	if err := s.accounts.CreatePendingMember(u, orgID, req.Role); err != nil {
		return nil, err
	}
	return s.sendWelcome(ctx, u, org, inviter, lang)
}

// ResendWelcome: otro enlace para alguien que no terminó el registro. El de
// antes deja de valer.
func (s *AccountService) ResendWelcome(ctx context.Context, orgID, userID, inviterID, lang string) (*domain.CreateAccountResponse, error) {
	u, err := s.users.FindByID(userID)
	if err != nil || !u.SetupPending {
		return nil, ErrAccountNotFound
	}
	if _, err := s.orgs.GetMembership(orgID, userID); err != nil {
		return nil, ErrAccountNotFound
	}
	org, err := s.orgs.FindByID(orgID)
	if err != nil {
		return nil, err
	}
	inviter, err := s.users.FindByID(inviterID)
	if err != nil {
		return nil, err
	}
	return s.sendWelcome(ctx, u, org, inviter, lang)
}

func (s *AccountService) sendWelcome(ctx context.Context, u *domain.User, org *domain.Organization, inviter *domain.User, lang string) (*domain.CreateAccountResponse, error) {
	token, err := s.newLink(u.ID, domain.LinkWelcome, org.ID, inviter.ID, welcomeTTL)
	if err != nil {
		return nil, err
	}
	link := s.publicURL + "/app/welcome#" + token
	args := map[string]string{"inviter": displayName(inviter), "org": org.Name, "name": displayName(u)}
	// En el idioma del admin: la persona todavía no eligió el suyo.
	sent := s.send(ctx, renderEmail(emailLocale(inviter.Locale, lang), u.Email, mailWelcome, args, link))
	out := &domain.CreateAccountResponse{Status: domain.AccountCreated, UserID: u.ID, EmailSent: sent}
	// Si el correo no salió, el admin se lo pasa a mano. Sólo entonces: el
	// enlace pone la contraseña de otra persona, y quien lo tiene puede entrar
	// en su lugar.
	if !sent {
		out.Link = link
	}
	return out, nil
}

// InspectLink: de quién es un enlace y para qué, sin gastarlo.
func (s *AccountService) InspectLink(token string) (*domain.AccountLinkInfo, error) {
	for _, purpose := range []string{domain.LinkWelcome, domain.LinkReset} {
		l, err := s.accounts.FindLink(token, purpose, s.now())
		if errors.Is(err, repository.ErrLinkInvalid) {
			continue
		}
		if err != nil {
			return nil, err
		}
		u, err := s.users.FindByID(l.UserID)
		if err != nil {
			return nil, repository.ErrLinkInvalid
		}
		info := &domain.AccountLinkInfo{Purpose: purpose, Name: u.Name, Email: u.Email}
		if l.OrgID != "" {
			if org, err := s.orgs.FindByID(l.OrgID); err == nil {
				info.OrgName = org.Name
			}
		}
		return info, nil
	}
	return nil, repository.ErrLinkInvalid
}

// CompleteWelcome: la persona elige su usuario y su contraseña, y entra.
func (s *AccountService) CompleteWelcome(req domain.CompleteWelcomeRequest) (*domain.AuthResponse, error) {
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if !usernamePattern.MatchString(username) || strings.HasPrefix(username, "pending-") {
		return nil, ErrBadUsername
	}
	hashed, err := repository.HashPassword(req.Password)
	if err != nil {
		return nil, err
	}
	l, err := s.accounts.UseLink(req.Token, domain.LinkWelcome, s.now(), func(tx *gorm.DB, l *domain.AccountLink) error {
		taken, err := repository.UsernameTaken(tx, username, l.UserID)
		if err != nil {
			return err
		}
		if taken {
			return repository.ErrUsernameTaken
		}
		res := tx.Model(&domain.User{}).Where("id = ? AND setup_pending", l.UserID).Updates(map[string]any{
			"username": username, "password": hashed, "setup_pending": false, "must_change_password": false,
		})
		if res.Error != nil {
			if repository.IsUniqueViolation(res.Error) {
				return repository.ErrUsernameTaken
			}
			return res.Error
		}
		if res.RowsAffected == 0 {
			return repository.ErrLinkInvalid
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	u, err := s.users.FindByID(l.UserID)
	if err != nil {
		return nil, err
	}
	return s.auth.SessionFor(u, req.Client == "web")
}

// ForgotPassword manda el enlace para restablecer, si hay a quién.
//
// Contesta lo mismo exista o no la cuenta, y tarde lo mismo (el correo sale
// aparte): si no, sirve para averiguar qué usuarios y qué correos hay.
func (s *AccountService) ForgotPassword(ctx context.Context, login, lang string) error {
	if s.mail == nil {
		return ErrMailOff
	}
	u, err := s.accounts.FindByLogin(login)
	if err != nil || u.SetupPending || u.Email == "" {
		return nil
	}
	token, err := s.newLink(u.ID, domain.LinkReset, "", u.ID, resetTTL)
	if err != nil {
		return err
	}
	e := renderEmail(emailLocale(u.Locale, lang), u.Email, mailReset,
		map[string]string{"username": u.Username, "name": displayName(u)},
		s.publicURL+"/app/reset-password#"+token)
	if s.async {
		go s.send(context.WithoutCancel(ctx), e)
	} else {
		s.send(ctx, e)
	}
	return nil
}

// ResetPassword pone la contraseña nueva, cierra todas las sesiones (como
// cambiarla: si la restableces es porque alguien podía saberla) y abre una.
func (s *AccountService) ResetPassword(req domain.ResetPasswordRequest) (*domain.AuthResponse, error) {
	hashed, err := repository.HashPassword(req.Password)
	if err != nil {
		return nil, err
	}
	l, err := s.accounts.UseLink(req.Token, domain.LinkReset, s.now(), func(tx *gorm.DB, l *domain.AccountLink) error {
		res := tx.Model(&domain.User{}).Where("id = ? AND NOT setup_pending", l.UserID).Updates(map[string]any{
			"password": hashed, "must_change_password": false,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return repository.ErrLinkInvalid
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := s.auth.RevokeSessions(l.UserID); err != nil {
		return nil, err
	}
	u, err := s.users.FindByID(l.UserID)
	if err != nil {
		return nil, err
	}
	return s.auth.SessionFor(u, req.Client == "web")
}

func (s *AccountService) newLink(userID, purpose, orgID, byID string, ttl time.Duration) (string, error) {
	plain, hash, err := repository.GenerateAccountLink()
	if err != nil {
		return "", err
	}
	now := s.now()
	l := &domain.AccountLink{
		UserID: userID, Purpose: purpose, TokenHash: hash, OrgID: orgID,
		CreatedByUserID: byID, ExpiresAt: now.Add(ttl),
	}
	if err := s.accounts.CreateLink(l, now); err != nil {
		return "", err
	}
	_ = s.accounts.PruneLinks(now)
	return plain, nil
}

// send: si salió. Un fallo se apunta y no tumba nada: el alta ya está hecha y
// el admin recibe el enlace a mano.
func (s *AccountService) send(ctx context.Context, e domain.Email) bool {
	if s.mail == nil {
		return false
	}
	if err := s.mail.Send(ctx, e); err != nil {
		lg.Error("email: " + err.Error())
		return false
	}
	return true
}

// emailLocale: el idioma guardado de quien lo va a leer y, si no eligió, el
// de la petición.
func emailLocale(saved, acceptLanguage string) i18n.Locale {
	if l, ok := i18n.Known(saved); ok {
		return l
	}
	return i18n.FromAcceptLanguage(acceptLanguage)
}

// displayName: la regla de `nombreVisible` (repository/nombres.go) para quien
// ya está cargado en Go: el nombre, y sólo si no lo hay, el usuario.
func displayName(u *domain.User) string {
	if n := strings.TrimSpace(u.Name); n != "" {
		return n
	}
	return u.Username
}

func randomSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
