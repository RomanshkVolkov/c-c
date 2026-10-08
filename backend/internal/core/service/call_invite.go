package service

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	// ErrInviteInvalid: el enlace no es de ninguna invitación. Firma mala o una
	// invitación que no existe contestan lo mismo, a propósito: distinguirlas
	// le diría a quien prueba enlaces cuáles existen.
	ErrInviteInvalid = errors.New("invite-invalid")
	ErrInviteExpired = errors.New("invite-expired")
	ErrInviteRevoked = errors.New("invite-revoked")
	// ErrGuestRemoved: a esta persona la echaron, y su pase no la deja volver.
	ErrGuestRemoved = errors.New("guest-removed")
	// ErrGuestName: hace falta un nombre que se pueda enseñar.
	ErrGuestName = errors.New("guest-name-required")
	// ErrOnlyGuests: desde una reunión sólo se puede echar a gente de fuera. A
	// un miembro no se le echa desde aquí: sigue teniendo su canal y su cuenta.
	ErrOnlyGuests = errors.New("kick-member-not-allowed")
	// ErrRecordingNeedsSpace: una reunión que no cuelga de un canal no tiene
	// dónde guardar ni anunciar su grabación.
	ErrRecordingNeedsSpace = errors.New("recording-needs-space")
)

// CallInviteService: invitar a gente de fuera a una llamada (W3).
//
// Ver domain/call_invite.go para el porqué de la sala propia y de la identidad
// `guest:`. Aquí vive el resto: quién puede entrar con qué, y cómo se le saca.
type CallInviteService struct {
	repo  *repository.CallInviteRepository
	voice *VoiceService
	// lk es para mirar dentro de la sala y echar. Puede ser nil en una
	// instalación sin LiveKit: entonces tampoco hay a quién echar.
	lk lkclient.Client
	// rec es para decirle al invitado, antes de entrar, si se graba.
	rec *RecordingService
	now func() time.Time
}

func NewCallInviteService(repo *repository.CallInviteRepository, voice *VoiceService,
	lk lkclient.Client, rec *RecordingService) *CallInviteService {
	return &CallInviteService{repo: repo, voice: voice, lk: lk, rec: rec,
		now: func() time.Time { return time.Now().UTC() }}
}

// ─── Lo que hace un miembro ──────────────────────────────────────────────────

// Create abre una invitación. Quien llama ya comprobó que puede escribir en la
// organización y, si hay canal, que el canal es de ella.
func (s *CallInviteService) Create(orgID string, spaceID *string, createdBy, title string,
	ttlHours, maxGuests int) (*domain.CallInvite, error) {
	ttl := domain.CallInviteTTLDefault
	if ttlHours > 0 {
		ttl = time.Duration(ttlHours) * time.Hour
	}
	ttl = min(max(ttl, domain.CallInviteTTLMin), domain.CallInviteTTLMax)
	inv := &domain.CallInvite{
		OrgID: orgID, SpaceID: spaceID, Title: strings.TrimSpace(title),
		CreatedBy: createdBy, ExpiresAt: s.now().Add(ttl), MaxGuests: max(maxGuests, 0),
	}
	if err := s.repo.Create(inv); err != nil {
		return nil, err
	}
	return inv, nil
}

func (s *CallInviteService) Find(id string) (*domain.CallInvite, error) {
	return s.repo.FindByID(id)
}

// List: las invitaciones vivas de una organización (o de un canal), con quién
// está dentro de cada una.
func (s *CallInviteService) List(ctx context.Context, orgID, spaceID string) ([]domain.CallInviteResponse, error) {
	rows, err := s.repo.ListLive(orgID, spaceID, s.now())
	if err != nil {
		return nil, err
	}
	rooms := make([]string, len(rows))
	for i, inv := range rows {
		rooms[i] = inv.Room()
	}
	occ := s.occupancy(ctx, rooms)
	out := make([]domain.CallInviteResponse, 0, len(rows))
	for _, inv := range rows {
		out = append(out, s.respond(inv, occ[inv.Room()]))
	}
	return out, nil
}

// Describe: una invitación para un miembro, con su enlace.
func (s *CallInviteService) Describe(ctx context.Context, inv *domain.CallInvite) domain.CallInviteResponse {
	return s.respond(*inv, s.occupancy(ctx, []string{inv.Room()})[inv.Room()])
}

func (s *CallInviteService) respond(inv domain.CallInvite, occ []OcupanteResponse) domain.CallInviteResponse {
	out := domain.CallInviteResponse{
		CallInvite: inv, Link: repository.SignCallInviteLink(inv.ID),
		Occupants: make([]domain.OccupantResponse, 0, len(occ)),
	}
	for _, o := range occ {
		out.Occupants = append(out.Occupants, domain.OccupantResponse{Identity: o.Identity, Name: o.Name})
	}
	if name, err := s.repo.DisplayName(inv.CreatedBy); err == nil {
		out.CreatedByName = name
	}
	if inv.SpaceID != nil {
		if name, err := s.repo.SpaceName(*inv.SpaceID); err == nil {
			out.SpaceName = name
		}
	}
	return out
}

// occupancy no tumba la lista si el SFU no contesta: una lista sin «quién está
// dentro» sirve igual para copiar un enlace.
func (s *CallInviteService) occupancy(ctx context.Context, rooms []string) map[string][]OcupanteResponse {
	occ, err := s.voice.OccupancyOf(ctx, rooms)
	if err != nil {
		lg.Warn("call invites: reading occupancy: " + err.Error())
		return map[string][]OcupanteResponse{}
	}
	return occ
}

// Revoke cierra el enlace **y saca a los invitados que estén dentro**.
//
// Lo segundo es lo que hace que revocar signifique algo: un enlace cerrado con
// la persona todavía dentro sólo impediría que vuelva si se le cae la red. Los
// miembros se quedan; la reunión sigue siendo suya.
func (s *CallInviteService) Revoke(ctx context.Context, inv *domain.CallInvite) error {
	if err := s.repo.Revoke(inv.ID, s.now()); err != nil {
		return err
	}
	if s.lk == nil {
		return nil
	}
	people, err := s.lk.Participants(ctx, inv.Room())
	if err != nil {
		// Una sala que no existe no tiene a nadie dentro: es lo normal al
		// revocar un enlace que nadie llegó a usar.
		return nil
	}
	for _, p := range people {
		if !domain.IsGuestIdentity(p.Identity) {
			continue
		}
		if err := s.lk.RemoveParticipant(ctx, inv.Room(), p.Identity); err != nil {
			lg.Warn("call invites: removing " + p.Identity + " on revoke: " + err.Error())
		}
	}
	return nil
}

// MemberToken: la entrada de un miembro a la reunión. Con su nombre visible,
// que es el que verán también los de fuera.
func (s *CallInviteService) MemberToken(inv *domain.CallInvite, userID, fallbackName string) (*domain.MeetTokenResponse, error) {
	if err := s.alive(inv); err != nil {
		return nil, err
	}
	name := fallbackName
	if n, err := s.repo.DisplayName(userID); err == nil && n != "" {
		name = n
	}
	tok, err := s.voice.TokenFor(inv.Room(), userID, name, MemberProfile)
	if err != nil {
		return nil, err
	}
	return &domain.MeetTokenResponse{
		URL: s.voice.URL(), Token: tok, Room: inv.Room(), OrgID: inv.OrgID,
		SpaceID: inv.SpaceID, InviteID: inv.ID, Title: inv.Title,
	}, nil
}

// Kick saca a un invitado y le cierra la puerta.
//
// Sólo a invitados: el prefijo se mira **aquí**, no en la pantalla, porque la
// identidad llega en la URL y cualquiera puede escribir la de un compañero.
func (s *CallInviteService) Kick(ctx context.Context, inv *domain.CallInvite, actorID, identity string) error {
	guestID, ok := domain.GuestIDOf(identity)
	if !ok {
		return ErrOnlyGuests
	}
	// Primero la fila: si el SFU falla, al menos no vuelve a entrar.
	if err := s.repo.KickGuest(inv.ID, guestID, actorID, s.now()); err != nil {
		return err
	}
	if s.lk == nil {
		return nil
	}
	return s.lk.RemoveParticipant(ctx, inv.Room(), identity)
}

// RecordingTarget: dónde se graba esta reunión. Sin canal no se graba.
func (s *CallInviteService) RecordingTarget(inv *domain.CallInvite) (RecordingTarget, error) {
	if inv.SpaceID == nil || *inv.SpaceID == "" {
		return RecordingTarget{}, ErrRecordingNeedsSpace
	}
	id := inv.ID
	return RecordingTarget{OrgID: inv.OrgID, SpaceID: *inv.SpaceID, Room: inv.Room(), InviteID: &id}, nil
}

// ─── Lo que hace alguien de fuera ────────────────────────────────────────────

// Inspect: lo que el invitado ve antes de entrar. Sin ids (ver
// `domain.PublicCallInvite`).
func (s *CallInviteService) Inspect(token string) (*domain.PublicCallInvite, error) {
	inv, err := s.open(token)
	if err != nil {
		return nil, err
	}
	out := &domain.PublicCallInvite{Title: inv.Title, ExpiresAt: inv.ExpiresAt}
	if name, err := s.repo.OrgName(inv.OrgID); err == nil {
		out.OrgName = name
	}
	if name, err := s.repo.DisplayName(inv.CreatedBy); err == nil {
		out.HostName = name
	}
	out.RecordingPossible, out.RecordingActive = s.recordingState(inv)
	return out, nil
}

func (s *CallInviteService) recordingState(inv *domain.CallInvite) (possible, active bool) {
	if s.rec == nil || !s.rec.Enabled() || inv.SpaceID == nil {
		return false, false
	}
	pol, err := s.rec.PolicyForRoom(inv.Room())
	if err != nil {
		// Ante la duda, se avisa: decirle a alguien que puede que se le grabe
		// cuando no es cierto cuesta menos que lo contrario.
		return true, false
	}
	return true, pol.Active != nil
}

// JoinAsGuest deja entrar a alguien de fuera.
//
// Con pase, vuelve quien ya estaba: misma identidad y mismo nombre, salvo que
// lo hayan echado. Sin pase, entra alguien nuevo con el nombre que escribió.
// **La identidad la acuña siempre el servidor**: el nombre es sólo para
// pintarlo, y nunca decide quién es nadie.
func (s *CallInviteService) JoinAsGuest(token, name, pass string) (*domain.GuestJoinResponse, error) {
	inv, err := s.open(token)
	if err != nil {
		return nil, err
	}
	now := s.now()

	var guest *domain.CallGuest
	if pass != "" {
		if id, ok := repository.VerifyGuestPass(inv.ID, pass, now); ok {
			g, err := s.repo.FindGuest(inv.ID, id)
			if err != nil && !errors.Is(err, repository.ErrCallGuestNotFound) {
				return nil, err
			}
			if g != nil && g.KickedAt != nil {
				return nil, ErrGuestRemoved
			}
			guest = g
		}
		// Un pase caducado o ajeno no es un error: se entra como alguien nuevo,
		// que es lo que haría cualquiera que abre el enlace por primera vez.
	}
	if guest == nil {
		clean, ok := CleanGuestName(name)
		if !ok {
			return nil, ErrGuestName
		}
		guest = &domain.CallGuest{InviteID: inv.ID, Name: clean, LastJoinAt: now}
		if err := s.repo.AddGuest(inv, guest); err != nil {
			return nil, err
		}
	} else if err := s.repo.TouchGuest(guest.ID, now); err != nil {
		lg.Warn("call invites: touching guest " + guest.ID + ": " + err.Error())
	}

	identity := domain.GuestIdentity(guest.ID)
	tok, err := s.voice.TokenFor(inv.Room(), identity, guest.Name, GuestProfile)
	if err != nil {
		return nil, err
	}
	return &domain.GuestJoinResponse{
		URL: s.voice.URL(), Token: tok, Room: inv.Room(), Identity: identity,
		Name: guest.Name, Pass: repository.MintGuestPass(inv.ID, guest.ID, inv.ExpiresAt, now),
		Title: inv.Title,
	}, nil
}

// open: la invitación viva que abre un enlace.
func (s *CallInviteService) open(token string) (*domain.CallInvite, error) {
	id, ok := repository.VerifyCallInviteLink(token)
	if !ok {
		return nil, ErrInviteInvalid
	}
	inv, err := s.repo.FindByID(id)
	if errors.Is(err, repository.ErrCallInviteNotFound) {
		return nil, ErrInviteInvalid
	}
	if err != nil {
		return nil, err
	}
	if err := s.alive(inv); err != nil {
		return nil, err
	}
	return inv, nil
}

func (s *CallInviteService) alive(inv *domain.CallInvite) error {
	if inv.RevokedAt != nil {
		return ErrInviteRevoked
	}
	if !inv.Live(s.now()) {
		return ErrInviteExpired
	}
	return nil
}

// CleanGuestName deja un nombre que se puede enseñar: sin caracteres de
// control, sin espacios de sobra y de 1 a 60 letras.
//
// Lo de los caracteres de control no es estética: el nombre se pinta en la
// pantalla de todos los que están en la llamada, y un salto de línea o un
// carácter de dirección (RLO) basta para que «Ana» se lea como otra cosa.
func CleanGuestName(raw string) (string, bool) {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(raw) {
		switch {
		case unicode.IsSpace(r):
			space = true
			continue
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r):
			continue
		}
		if space && b.Len() > 0 {
			b.WriteRune(' ')
		}
		space = false
		b.WriteRune(r)
	}
	r := []rune(b.String())
	if len(r) == 0 {
		return "", false
	}
	if len(r) > domain.GuestNameMax {
		r = []rune(strings.TrimSpace(string(r[:domain.GuestNameMax])))
	}
	return string(r), true
}
