package service

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ErrNotTheAuthor: editing or withdrawing somebody else's words.
//
// The same rule the item threads apply, and for the same reason: rewriting what
// another person said is not a permission an org role should grant. A superadmin
// is the one exception, as elsewhere.
var ErrNotTheAuthor = errors.New("only the author can change this message")

type ChatService struct {
	repo     *repository.ChatRepository
	hub      *events.Hub
	notifier Notifier
}

func NewChatService(repo *repository.ChatRepository, hub *events.Hub) *ChatService {
	return &ChatService{repo: repo, hub: hub}
}

// WithNotifier records mentions, so being named survives closing the app.
// Only mentions: a channel message is for everyone in it, and an inbox row per
// person per message would turn the inbox into the channel.
func (s *ChatService) WithNotifier(n Notifier) *ChatService {
	s.notifier = n
	return s
}

// publish tells the consoles of one organization that a channel moved.
//
// Deliberately the hub and nothing else. The other publisher in this codebase,
// emitItemEvent, also dispatches the tenant's webhook — reaching for it here
// would put a private team conversation on a client's doorstep. Chat has no
// audience outside cac, so it uses the narrow path on purpose, and this comment
// is here so nobody "unifies" the two later.
//
// actorId rides along from day one. Every console in the organization hears this
// stream, including the one that just typed the message, and without a name on
// the event the app announces it back at its author — a bug this codebase found
// the hard way the day before this feature was written.
func (s *ChatService) publish(orgID, spaceID, messageID, actorID string, mentions []string) {
	if orgID == "" {
		return
	}
	// El bus y la bandeja son dos trabajos distintos, y por eso se guardan por
	// separado. Estaban bajo la misma condición: sin bus no se anotaba **ni
	// una** notificación, así que una configuración sin Valkey dejaba de avisar
	// a todo el mundo sin dar ningún error. Nadie lo habría visto hasta que
	// alguien se quejara de no enterarse de nada.
	if s.hub != nil {
		s.publicarAlStream(orgID, spaceID, messageID, actorID, mentions)
	}
	s.anotarAvisos(orgID, spaceID, actorID, mentions)
}

func (s *ChatService) publicarAlStream(orgID, spaceID, messageID, actorID string, mentions []string) {
	s.hub.Publish(events.Event{
		Type:  "chat:message",
		OrgID: orgID,
		Data: map[string]any{
			"spaceId": spaceID, "messageId": messageID, "actorId": actorID,
			// Who was named. Sent to the whole organization along with the rest
			// of the event — the channel is theirs to read anyway — and each
			// console decides whether it is being spoken to. Nothing private
			// travels here: these are ids of people who share this channel.
			"mentions": mentions,
		},
	})
}

func (s *ChatService) anotarAvisos(orgID, spaceID, actorID string, mentions []string) {
	if s.notifier == nil {
		return
	}
	for _, uid := range mentions {
		// Not the author: being told you named somebody is the app talking to
		// itself, and this codebase has already shipped that bug once.
		if uid == actorID {
			continue
		}
		// ViaApp fijo: hoy ninguna herramienta del MCP escribe en un canal. El
		// día que exista una, este servicio tendrá que recibir el contexto de
		// la petición — si no, un mensaje del agente se pintará como tuyo.
		s.notifier.Notify(uid, orgID, "chat:mention",
			"You were mentioned", "", "/chat?space="+spaceID, domain.ViaApp)
	}

	// Y a quien sigue el canal, por lo corriente. Sólo a quien lo sigue: avisar
	// a todo el espacio de cada línea convierte la bandeja en una copia del
	// chat, y cuarenta mensajes de un canal ajeno tapan la mención que sí te
	// buscaba. Sin repetir a los ya nombrados, que acaban de recibir el suyo.
	nombrados := make(map[string]bool, len(mentions))
	for _, uid := range mentions {
		nombrados[uid] = true
	}
	seguidores, err := s.repo.Followers(spaceID)
	if err != nil {
		return
	}
	for _, uid := range seguidores {
		if uid == actorID || nombrados[uid] {
			continue
		}
		s.notifier.Notify(uid, orgID, "chat:message",
			"New message in a channel you follow", "", "/chat?space="+spaceID, domain.ViaApp)
	}
}

// Follow / Unfollow / Following: quién quiere enterarse de lo que se hable
// aquí. La autorización por pertenencia a la organización la aplica el handler,
// igual que en el resto del módulo.
func (s *ChatService) Follow(spaceID, userID string) error {
	return s.repo.Follow(spaceID, userID)
}

func (s *ChatService) Unfollow(spaceID, userID string) error {
	return s.repo.Unfollow(spaceID, userID)
}

func (s *ChatService) Following(userID string) ([]string, error) {
	return s.repo.FollowedSpaces(userID)
}

// mentioned answers who this body actually names.
//
// The ids come out of text the author typed, so they are asserted and nothing
// more. Anyone not in this organization is dropped rather than refused: naming
// a stranger is not an error worth failing a message over, it just doesn't ping
// anybody.
func (s *ChatService) mentioned(orgID, body string) []string {
	named := domain.ExtractMentions(body)
	if len(named) == 0 {
		return nil
	}
	ok, err := s.repo.MembersOf(orgID, named)
	if err != nil {
		// A message that sends is better than a message refused because the
		// membership lookup blinked; it simply pings nobody.
		return nil
	}
	return ok
}

func (s *ChatService) List(spaceID string, before time.Time, limit int) ([]domain.ChatMessageResponse, error) {
	return s.repo.List(spaceID, before, limit)
}

func (s *ChatService) Post(spaceID, orgID, userID, body string) (*domain.ChatMessage, error) {
	m := &domain.ChatMessage{
		SpaceID: spaceID, OrgID: orgID, AuthorUserID: userID, Body: body,
	}
	m.ID = uuid.NewString()
	if err := s.repo.Create(m); err != nil {
		return nil, err
	}
	s.publish(orgID, spaceID, m.ID, userID, s.mentioned(orgID, body))
	return m, nil
}

// authoredBy answers whether this caller may change this message.
func authoredBy(m *domain.ChatMessage, userID string, superadmin bool) bool {
	return m.AuthorUserID == userID || superadmin
}

func (s *ChatService) Edit(messageID, userID string, superadmin bool, body string) error {
	m, err := s.repo.Find(messageID)
	if err != nil {
		return err
	}
	if !authoredBy(m, userID, superadmin) {
		return ErrNotTheAuthor
	}
	if err := s.repo.UpdateBody(messageID, body); err != nil {
		return err
	}
	// Same event as a new message: the receiver reloads the channel either way,
	// and a second event type would be two things to handle for one outcome.
	s.publish(m.OrgID, m.SpaceID, m.ID, userID, s.mentioned(m.OrgID, body))
	return nil
}

func (s *ChatService) Withdraw(messageID, userID string, superadmin bool) error {
	m, err := s.repo.Find(messageID)
	if err != nil {
		return err
	}
	if !authoredBy(m, userID, superadmin) {
		return ErrNotTheAuthor
	}
	if err := s.repo.Withdraw(messageID); err != nil {
		return err
	}
	// A withdrawn message names nobody: pinging over something just retracted
	// would be the opposite of retracting it.
	s.publish(m.OrgID, m.SpaceID, m.ID, userID, nil)
	return nil
}

func (s *ChatService) MarkRead(spaceID, userID string) error {
	return s.repo.MarkRead(spaceID, userID)
}

func (s *ChatService) Unread(userID string, orgIDs []string, superadmin bool) ([]domain.ChatUnread, error) {
	return s.repo.UnreadBySpace(userID, orgIDs, superadmin)
}

func (s *ChatService) AddAttachment(a *domain.ChatAttachment) error {
	return s.repo.CreateAttachment(a)
}

func (s *ChatService) FindAttachment(id string) (*domain.ChatAttachment, error) {
	return s.repo.FindAttachment(id)
}
