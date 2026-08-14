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
	repo *repository.ChatRepository
	hub  *events.Hub
}

func NewChatService(repo *repository.ChatRepository, hub *events.Hub) *ChatService {
	return &ChatService{repo: repo, hub: hub}
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
func (s *ChatService) publish(orgID, spaceID, messageID, actorID string) {
	if s.hub == nil || orgID == "" {
		return
	}
	s.hub.Publish(events.Event{
		Type:  "chat:message",
		OrgID: orgID,
		Data: map[string]string{
			"spaceId": spaceID, "messageId": messageID, "actorId": actorID,
		},
	})
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
	s.publish(orgID, spaceID, m.ID, userID)
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
	s.publish(m.OrgID, m.SpaceID, m.ID, userID)
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
	s.publish(m.OrgID, m.SpaceID, m.ID, userID)
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
