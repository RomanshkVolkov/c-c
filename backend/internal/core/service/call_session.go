package service

import (
	"context"
	"time"

	lksdk "github.com/livekit/protocol/livekit"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/core/domain"
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
	now        func() time.Time
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

// Open: alguien va a entrar a esta sala. **Nunca falla la entrada**: una
// llamada sin sesión es una llamada sin resumen, no una llamada que no se
// puede hacer. Lo que falle se queda en el log.
func (s *CallSessionService) Open(orgID string, spaceID *string, room string, inviteID *string, userID string) {
	if s == nil {
		return
	}
	now := s.now()
	_, err := s.repo.Open(&domain.CallSession{
		OrgID: orgID, SpaceID: spaceID, Room: room, InviteID: inviteID,
		StartedBy: userID, StartedAt: now, TickedAt: now,
	})
	if err != nil {
		lg.Error("call: opening the session of " + room + ": " + err.Error())
	}
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
	// Los mensajes del chat de la llamada llegan en la tanda 3; hasta
	// entonces, cero.
	if !domain.WorthSummarizing(duration, len(people), 0) {
		return
	}
	body, notice := domain.CallSummary(cs.ID, duration, len(people), s.readyRecording(cs.RecordingID))
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
	body, _ := domain.CallSummary(cs.ID, cs.EndedAt.Sub(cs.StartedAt), len(people), s.readyRecording(cs.RecordingID))
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
	return cs, out, nil
}

func samePtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
