package service

import (
	"context"
	"errors"
	"strings"
	"time"

	lksdk "github.com/livekit/protocol/livekit"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Las llamadas, guardadas: se abren al dar la entrada, las cierra un reloj y
// dejan su resumen en el canal. Ver domain/call_session.go.

// Summarizer es lo que hace falta del chat del canal: poner la línea del
// resumen y reescribirla cuando la grabación queda lista.
type Summarizer interface {
	PostSystem(spaceID, orgID, actorID, body, notice string) (*domain.ChatMessage, error)
	UpdateSystem(messageID, body string) error
}

type CallSessionService struct {
	repo       *repository.CallSessionRepository
	recordings *repository.RecordingRepository
	lk         lkclient.Client
	summarizer Summarizer
	// hub: por donde llega cada mensaje del chat a quien está en la llamada.
	hub *events.Hub
	now func() time.Time
}

func (s *CallSessionService) WithHub(h *events.Hub) *CallSessionService {
	s.hub = h
	return s
}

func NewCallSessionService(repo *repository.CallSessionRepository, recordings *repository.RecordingRepository,
	lk lkclient.Client) *CallSessionService {
	return &CallSessionService{repo: repo, recordings: recordings, lk: lk,
		now: func() time.Time { return time.Now().UTC() }}
}

func (s *CallSessionService) WithSummarizer(sum Summarizer) *CallSessionService {
	s.summarizer = sum
	return s
}

// Open: alguien va a entrar a esta sala. Devuelve la sesión abierta, para su
// chat. **Nunca falla la entrada**: una llamada sin sesión es una llamada sin
// resumen ni chat propio, no una llamada que no se puede hacer. Lo que falle
// se queda en el log y devuelve "".
func (s *CallSessionService) Open(orgID string, spaceID *string, room string, inviteID *string, userID string) string {
	if s == nil {
		return ""
	}
	now := s.now()
	cs, err := s.repo.Open(&domain.CallSession{
		OrgID: orgID, SpaceID: spaceID, Room: room, InviteID: inviteID,
		StartedBy: userID, StartedAt: now, TickedAt: now,
	})
	if err != nil {
		lg.Error("call: opening the session of " + room + ": " + err.Error())
		return ""
	}
	return cs.ID
}

// Tick: una vuelta del reloj por cada sesión abierta. Corre en todas las
// réplicas; cada sesión la hace una sola, por `ClaimTick`.
func (s *CallSessionService) Tick(ctx context.Context, now time.Time) {
	open, err := s.repo.Unfinished()
	if err != nil {
		lg.Error("call: cannot list the open sessions: " + err.Error())
		return
	}
	for i := range open {
		cs := &open[i]
		claimed, err := s.repo.ClaimTick(cs.ID, cs.TickedAt, now)
		if err != nil || !claimed {
			continue
		}
		s.tickOne(ctx, cs, now)
	}
}

func (s *CallSessionService) tickOne(ctx context.Context, cs *domain.CallSession, now time.Time) {
	people, err := s.lk.Participants(ctx, cs.Room)
	if err != nil {
		// Una sala que ya no existe es una sala vacía: el SFU la tira cuando
		// se va el último. Igual que en la grabación.
		people = nil
	}
	if present(cs.Room, people) > 0 {
		if err := s.repo.Seen(cs.ID, now, seenIn(cs.ID, people, now)); err != nil {
			lg.Error("call: noting who is in " + cs.Room + ": " + err.Error())
		}
		return
	}
	cs.EmptyTicks++
	if cs.EmptyTicks < 2 {
		if err := s.repo.SetEmptyTicks(cs.ID, cs.EmptyTicks); err != nil {
			lg.Error("call: counting empty ticks: " + err.Error())
		}
		return
	}
	// El final es la última vez que hubo alguien, no este tick. Una sesión que
	// nadie llegó a ver dentro termina donde empezó.
	ended := cs.StartedAt
	if cs.LastSeenAt != nil {
		ended = *cs.LastSeenAt
	}
	closed, err := s.repo.Close(cs.ID, ended)
	if err != nil {
		lg.Error("call: closing " + cs.ID + ": " + err.Error())
		return
	}
	if !closed {
		return // la cerró otra réplica, y ésa resume
	}
	cs.EndedAt = &ended
	s.summarize(cs)
}

// seenIn: las personas de la sala, como filas de participante. Los
// agentes —el egress de la grabación— no son personas.
func seenIn(sessionID string, people []*lksdk.ParticipantInfo, now time.Time) []domain.CallSessionParticipant {
	out := make([]domain.CallSessionParticipant, 0, len(people))
	for _, p := range people {
		if p.Kind != lksdk.ParticipantInfo_STANDARD {
			continue
		}
		out = append(out, domain.CallSessionParticipant{
			SessionID: sessionID, Identity: p.Identity, Name: truncateName(p.Name),
			Guest: domain.IsGuestIdentity(p.Identity), FirstJoinedAt: now,
		})
	}
	return out
}

// summarize pone el resumen en el canal, si lo merece. Exactamente una vez:
// sólo lo llama quien cerró (ver `Close`).
func (s *CallSessionService) summarize(cs *domain.CallSession) {
	if s.summarizer == nil || cs.SpaceID == nil || cs.EndedAt == nil {
		return
	}
	people, err := s.repo.Participants(cs.ID)
	if err != nil {
		lg.Error("call: reading who was in " + cs.ID + ": " + err.Error())
		return
	}
	duration := cs.EndedAt.Sub(cs.StartedAt)
	messages, _ := s.repo.CountMessages(cs.ID)
	if !domain.WorthSummarizing(duration, len(people), int(messages)) {
		return
	}
	body, notice := domain.CallSummary(cs.ID, duration, len(people), int(messages), s.readyRecording(cs.RecordingID))
	msg, err := s.summarizer.PostSystem(*cs.SpaceID, cs.OrgID, cs.StartedBy, body, notice)
	if err != nil {
		lg.Error("call: summarizing " + cs.ID + " in the channel: " + err.Error())
		return
	}
	if err := s.repo.SetSummary(cs.ID, msg.ID); err != nil {
		lg.Error("call: noting the summary of " + cs.ID + ": " + err.Error())
		return
	}
	// La grabación pudo quedar lista mientras se escribía esto: si se enlazó
	// entre que se leyó la sesión y ahora, el resumen se reescribe con ella.
	// Ver RecordingReady, que hace la misma comprobación desde el otro lado.
	if fresh, err := s.repo.FindByID(cs.ID); err == nil && !samePtr(fresh.RecordingID, cs.RecordingID) {
		s.rewrite(fresh, msg.ID)
	}
}

// RecordingReady: una grabación quedó lista. Si es de una llamada guardada,
// va en su resumen y no en una línea aparte; devuelve true si se encargó y la
// grabación no tiene que anunciarse por su cuenta.
//
//   - Llamada todavía abierta: se queda enlazada y saldrá en el resumen al
//     terminar.
//   - Llamada terminada con resumen: se reescribe el resumen con ella.
//   - Terminada sin resumen (no lo merecía, o sin canal), o sin sesión
//     (grabaciones de antes de esto): false, y se anuncia como siempre.
func (s *CallSessionService) RecordingReady(rec *domain.Recording) bool {
	if s == nil {
		return false
	}
	cs, err := s.repo.LinkRecording(rec.Room, rec.StartedAt, rec.ID)
	if err != nil {
		lg.Error("call: linking recording " + rec.ID + ": " + err.Error())
		return false
	}
	if cs == nil {
		return false
	}
	if cs.EndedAt == nil {
		return true
	}
	if cs.SummaryMessageID == nil {
		return false
	}
	s.rewrite(cs, *cs.SummaryMessageID)
	return true
}

func (s *CallSessionService) rewrite(cs *domain.CallSession, messageID string) {
	if s.summarizer == nil || cs.EndedAt == nil {
		return
	}
	people, err := s.repo.Participants(cs.ID)
	if err != nil {
		lg.Error("call: reading who was in " + cs.ID + ": " + err.Error())
		return
	}
	messages, _ := s.repo.CountMessages(cs.ID)
	body, _ := domain.CallSummary(cs.ID, cs.EndedAt.Sub(cs.StartedAt), len(people), int(messages), s.readyRecording(cs.RecordingID))
	if err := s.summarizer.UpdateSystem(messageID, body); err != nil {
		lg.Error("call: rewriting the summary of " + cs.ID + ": " + err.Error())
	}
}

func (s *CallSessionService) readyRecording(id *string) *domain.Recording {
	if id == nil || s.recordings == nil {
		return nil
	}
	rec, err := s.recordings.FindByID(*id)
	if err != nil {
		return nil
	}
	return rec
}

func (s *CallSessionService) Find(id string) (*domain.CallSession, error) {
	return s.repo.FindByID(id)
}

// Get: una llamada con quién estuvo, para su tarjeta.
func (s *CallSessionService) Get(id string) (*domain.CallSession, *domain.CallSessionResponse, error) {
	cs, err := s.repo.FindByID(id)
	if err != nil {
		return nil, nil, err
	}
	people, err := s.repo.Participants(id)
	if err != nil {
		return nil, nil, err
	}
	out := &domain.CallSessionResponse{
		ID: cs.ID, SpaceID: cs.SpaceID, StartedAt: cs.StartedAt, EndedAt: cs.EndedAt,
		Participants: people, RecordingID: cs.RecordingID,
	}
	if cs.EndedAt != nil {
		out.DurationMs = cs.EndedAt.Sub(cs.StartedAt).Milliseconds()
	}
	out.Messages, _ = s.repo.CountMessages(id)
	return cs, out, nil
}

// ─── El chat de la llamada ────────────────────────────────────────────────────

var (
	// ErrCallEnded: la llamada terminó y su chat ya es de sólo lectura.
	ErrCallEnded = errors.New("this call has ended; its chat is read-only")
	// ErrNotYourCallMessage: editar o retirar lo de otro.
	ErrNotYourCallMessage = errors.New("only whoever wrote it can change it")
)

// Messages: el chat de una llamada, abierta o terminada, con sus reacciones
// contadas para `viewerID` (un usuario, o la identidad de un invitado). Quién
// puede leerlo lo decide el handler.
func (s *CallSessionService) Messages(sessionID, viewerID string) ([]domain.CallMessageResponse, error) {
	msgs, err := s.repo.Messages(sessionID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	sums, err := s.repo.Reactions().Summaries(domain.ReactionCall, ids, viewerID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.CallMessageResponse, len(msgs))
	for i, m := range msgs {
		out[i] = domain.CallMessageResponse{CallMessage: m, Reactions: sums[m.ID]}
		if out[i].Reactions == nil {
			out[i].Reactions = []domain.ReactionSummary{}
		}
	}
	return out, nil
}

// OpenIn: la llamada abierta de una sala, para el invitado (que no sabe su id).
func (s *CallSessionService) OpenIn(room string) (*domain.CallSession, error) {
	return s.repo.OpenIn(room)
}

// PostGuestMessage: lo que escribe un invitado admitido. Quién es lo decide el
// handler con su enlace y su pase; aquí, sólo que la llamada siga abierta.
func (s *CallSessionService) PostGuestMessage(cs *domain.CallSession, guestID, name, body string) (*domain.CallMessage, error) {
	if cs.EndedAt != nil {
		return nil, ErrCallEnded
	}
	gid := guestID
	m := &domain.CallMessage{
		SessionID: cs.ID, OrgID: cs.OrgID, AuthorGuestID: &gid,
		AuthorName: truncateName(name), Body: strings.TrimSpace(body),
	}
	if err := s.repo.CreateMessage(m); err != nil {
		return nil, err
	}
	s.publishMessage(cs, m.ID, domain.GuestIdentity(guestID))
	return m, nil
}

// React: un miembro reacciona a un mensaje del chat de una llamada (los
// invitados las ven, pero en la v1 no reaccionan). Con la llamada abierta o
// terminada: celebrar lo dicho no lo cambia.
func (s *CallSessionService) React(cs *domain.CallSession, messageID, userID, emoji string, on bool) error {
	if !domain.ValidReaction(emoji) {
		return ErrBadReaction
	}
	m, err := s.repo.FindMessage(messageID)
	if err != nil || m.SessionID != cs.ID {
		return repository.ErrCallMessageNotFound
	}
	if err := s.repo.Reactions().Set(domain.ReactionCall, m.ID, userID, emoji, on); err != nil {
		return err
	}
	s.publishMessage(cs, m.ID, userID)
	return nil
}

// PostMessage escribe en el chat **mientras dura la llamada**. Después es de
// sólo lectura: lo que se dijo en una reunión no se reescribe al día
// siguiente.
func (s *CallSessionService) PostMessage(cs *domain.CallSession, userID, fallbackName, body string) (*domain.CallMessage, error) {
	if cs.EndedAt != nil {
		return nil, ErrCallEnded
	}
	name := s.repo.DisplayName(userID)
	if name == "" {
		name = fallbackName
	}
	uid := userID
	m := &domain.CallMessage{
		SessionID: cs.ID, OrgID: cs.OrgID, AuthorUserID: &uid,
		AuthorName: truncateName(name), Body: strings.TrimSpace(body),
	}
	if err := s.repo.CreateMessage(m); err != nil {
		return nil, err
	}
	s.publishMessage(cs, m.ID, userID)
	return m, nil
}

// EditMessage y WithdrawMessage: sólo el autor, y sólo con la llamada abierta.
func (s *CallSessionService) EditMessage(cs *domain.CallSession, messageID, userID, body string) error {
	m, err := s.mine(cs, messageID, userID)
	if err != nil {
		return err
	}
	if err := s.repo.UpdateMessage(m.ID, strings.TrimSpace(body)); err != nil {
		return err
	}
	s.publishMessage(cs, m.ID, userID)
	return nil
}

func (s *CallSessionService) WithdrawMessage(cs *domain.CallSession, messageID, userID string) error {
	m, err := s.mine(cs, messageID, userID)
	if err != nil {
		return err
	}
	if err := s.repo.WithdrawMessage(m.ID); err != nil {
		return err
	}
	s.publishMessage(cs, m.ID, userID)
	return nil
}

func (s *CallSessionService) mine(cs *domain.CallSession, messageID, userID string) (*domain.CallMessage, error) {
	if cs.EndedAt != nil {
		return nil, ErrCallEnded
	}
	m, err := s.repo.FindMessage(messageID)
	if err != nil || m.SessionID != cs.ID {
		return nil, repository.ErrCallMessageNotFound
	}
	if m.AuthorUserID == nil || *m.AuthorUserID != userID {
		return nil, ErrNotYourCallMessage
	}
	return m, nil
}

// publishMessage: a la organización, sin el texto. Cada consola mira si es
// la llamada en la que está y sólo entonces pide el chat: el texto de una
// reunión no viaja a quien no está en ella.
func (s *CallSessionService) publishMessage(cs *domain.CallSession, messageID, actorID string) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(events.Event{
		Type: "call:message", OrgID: cs.OrgID,
		Data: map[string]any{"sessionId": cs.ID, "messageId": messageID, "actorId": actorID},
	})
}

func samePtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
