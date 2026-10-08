package service

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"strings"
	"time"
	"unicode"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
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
	// ErrGuestRejected: pidió entrar y le dijeron que no.
	ErrGuestRejected = errors.New("guest-rejected")
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
	// hub es por donde suena el timbre. Opcional: sin él no se llama a nadie.
	hub *events.Hub
	now func() time.Time
}

// WithHub engancha el stream de eventos, para el timbre.
func (s *CallInviteService) WithHub(hub *events.Hub) *CallInviteService {
	s.hub = hub
	return s
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

// Ring llama a un compañero a la reunión.
//
// Las mismas dos guardas que el timbre de un canal (`TaskService.Timbrar`):
// que quien llama sea de la organización —lo hizo el handler— y que a quien
// llama también. Y una más: la reunión tiene que seguir viva, o el timbre
// llevaría a una puerta cerrada.
func (s *CallInviteService) Ring(inv *domain.CallInvite, de domain.VoiceCaller, aUserID string) (*domain.VoiceRing, error) {
	if err := s.alive(inv); err != nil {
		return nil, err
	}
	if aUserID == "" || aUserID == de.ID || !s.repo.IsMember(inv.OrgID, aUserID) {
		return nil, ErrRingOutsider
	}
	id := inv.ID
	timbre := &domain.VoiceRing{
		RingID: uuid.NewString(), OrgID: inv.OrgID, From: de,
		InviteID: &id, Title: inv.Title,
		ExpiresAt: s.now().Add(TimbreTTL),
	}
	if inv.SpaceID != nil {
		timbre.SpaceID = *inv.SpaceID
		if name, err := s.repo.SpaceName(*inv.SpaceID); err == nil {
			timbre.SpaceName = name
		}
	}
	if s.hub != nil {
		s.hub.Publish(events.Event{Type: "voice.ring", OrgID: inv.OrgID, UserID: aUserID, Data: timbre})
	}
	PushToPhone(aUserID, domain.PushMessage{
		Kind: "voice.ring", Title: de.Name, Body: inv.Title,
		Link: "/call/" + inv.ID, Tag: meetRingTag(inv.ID, de.ID), OrgID: inv.OrgID,
	}, PushOptions{TTL: TimbreTTL, High: true})
	return timbre, nil
}

// CancelRing calla el teléfono de quien todavía no contestó.
func (s *CallInviteService) CancelRing(inv *domain.CallInvite, deUserID, aUserID string) error {
	if aUserID == "" || aUserID == deUserID || !s.repo.IsMember(inv.OrgID, aUserID) {
		return ErrRingOutsider
	}
	id := inv.ID
	if s.hub != nil {
		s.hub.Publish(events.Event{
			Type: "voice.ring.cancel", OrgID: inv.OrgID, UserID: aUserID,
			Data: &domain.VoiceRingCancel{From: deUserID, InviteID: &id},
		})
	}
	PushToPhone(aUserID, domain.PushMessage{
		Kind: "voice.ring.cancel", Tag: meetRingTag(inv.ID, deUserID), OrgID: inv.OrgID,
	}, PushOptions{TTL: TimbreTTL, High: true})
	return nil
}

func meetRingTag(inviteID, fromID string) string { return "ring:meet:" + inviteID + ":" + fromID }

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

// JoinAsGuest: alguien de fuera pide entrar.
//
// **Pedir no es entrar.** Sin pase, se le apunta en la sala de espera y se
// avisa a los de dentro; la respuesta lleva su pase y **ningún token**. Con
// pase, vuelve quien ya pidió: si le dejaron, recibe la entrada (es la
// reconexión de alguien admitido); si sigue esperando, sigue esperando; si le
// rechazaron o le echaron, no.
//
// **La identidad la acuña siempre el servidor**: el nombre es sólo para
// pintarlo, y nunca decide quién es nadie.
func (s *CallInviteService) JoinAsGuest(token, name, pass string) (*domain.GuestJoinResponse, error) {
	inv, err := s.open(token)
	if err != nil {
		return nil, err
	}
	if pass != "" {
		g, err := s.guestByPass(inv, pass)
		if err != nil {
			return nil, err
		}
		if g != nil {
			return s.entry(inv, g)
		}
		// Un pase caducado o ajeno no es un error: se pide entrar como alguien
		// nuevo, que es lo que haría cualquiera que abre el enlace.
	}
	clean, ok := CleanGuestName(name)
	if !ok {
		return nil, ErrGuestName
	}
	g := &domain.CallGuest{InviteID: inv.ID, Name: clean, LastJoinAt: s.now()}
	if err := s.repo.AddWaiting(inv, g); err != nil {
		return nil, err
	}
	s.knock(inv, g)
	return s.entry(inv, g)
}

// GuestStatus: quien espera vuelve a preguntar con su pase. Cuando le dejan
// entrar, la respuesta trae la entrada.
func (s *CallInviteService) GuestStatus(token, pass string) (*domain.GuestJoinResponse, error) {
	inv, err := s.open(token)
	if err != nil {
		return nil, err
	}
	g, err := s.guestByPass(inv, pass)
	if err != nil {
		return nil, err
	}
	if g == nil {
		return nil, ErrInviteInvalid
	}
	return s.entry(inv, g)
}

// guestByPass: la fila del pase, si el pase vale. `nil, nil` si no vale.
// Echado o rechazado es un error: con ese pase no se vuelve.
func (s *CallInviteService) guestByPass(inv *domain.CallInvite, pass string) (*domain.CallGuest, error) {
	id, ok := repository.VerifyGuestPass(inv.ID, pass, s.now())
	if !ok {
		return nil, nil
	}
	g, err := s.repo.FindGuest(inv.ID, id)
	if errors.Is(err, repository.ErrCallGuestNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if g.KickedAt != nil {
		return nil, ErrGuestRemoved
	}
	if g.Status == domain.GuestRejected {
		return nil, ErrGuestRejected
	}
	return g, nil
}

// entry: la respuesta para un invitado. **El token sólo si está admitido.**
func (s *CallInviteService) entry(inv *domain.CallInvite, g *domain.CallGuest) (*domain.GuestJoinResponse, error) {
	now := s.now()
	out := &domain.GuestJoinResponse{
		Status: g.Status, Name: g.Name, Title: inv.Title,
		Pass: repository.MintGuestPass(inv.ID, g.ID, inv.ExpiresAt, now),
	}
	if g.Status != domain.GuestAdmitted {
		return out, nil
	}
	if err := s.repo.TouchGuest(g.ID, now); err != nil {
		lg.Warn("call invites: touching guest " + g.ID + ": " + err.Error())
	}
	identity := domain.GuestIdentity(g.ID)
	tok, err := s.voice.TokenFor(inv.Room(), identity, g.Name, GuestProfile)
	if err != nil {
		return nil, err
	}
	out.URL, out.Token, out.Room, out.Identity = s.voice.URL(), tok, inv.Room(), identity
	return out, nil
}

// Waiting: quién espera, para los de dentro.
func (s *CallInviteService) Waiting(inv *domain.CallInvite) ([]domain.WaitingGuest, error) {
	rows, err := s.repo.Waiting(inv.ID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.WaitingGuest, 0, len(rows))
	for _, g := range rows {
		out = append(out, domain.WaitingGuest{ID: g.ID, Name: g.Name, CreatedAt: g.CreatedAt})
	}
	return out, nil
}

// Admit deja entrar a quien espera. La reunión tiene que seguir viva: dejar
// entrar por una puerta que ya se cerró no tendría a dónde llevar.
func (s *CallInviteService) Admit(inv *domain.CallInvite, guestID, by string) error {
	if err := s.alive(inv); err != nil {
		return err
	}
	if err := s.repo.Admit(inv, guestID, by, s.now()); err != nil {
		return err
	}
	s.decided(inv, guestID, domain.GuestAdmitted)
	return nil
}

// Reject le dice que no a quien espera. Con ese pase ya no vuelve a pedir.
func (s *CallInviteService) Reject(inv *domain.CallInvite, guestID, by string) error {
	if err := s.repo.Reject(inv.ID, guestID, by, s.now()); err != nil {
		return err
	}
	s.decided(inv, guestID, domain.GuestRejected)
	return nil
}

// knock avisa a la organización de que alguien espera. A la organización y no
// a una persona: quien decide es cualquiera que esté dentro, y la app sólo lo
// pinta en la reunión abierta o a quien la creó.
func (s *CallInviteService) knock(inv *domain.CallInvite, g *domain.CallGuest) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(events.Event{Type: "call:knock", OrgID: inv.OrgID, Data: domain.CallKnock{
		InviteID: inv.ID, Title: inv.Title, CreatedBy: inv.CreatedBy, Status: domain.GuestWaiting,
		Guest: domain.WaitingGuest{ID: g.ID, Name: g.Name, CreatedAt: g.CreatedAt},
	}})
}

// decided avisa de que alguien ya no espera, para que la lista de los demás
// miembros se vacíe sola.
func (s *CallInviteService) decided(inv *domain.CallInvite, guestID string, st domain.GuestStatus) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(events.Event{Type: "call:knock", OrgID: inv.OrgID, Data: domain.CallKnock{
		InviteID: inv.ID, Title: inv.Title, CreatedBy: inv.CreatedBy, Status: st,
		Guest: domain.WaitingGuest{ID: guestID},
	}})
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
