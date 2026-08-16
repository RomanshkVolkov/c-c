package service

import (
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Direct messages: two people, one organization.
//
// The authorship rule and the shape of every operation match the space
// channels, because writing is writing. What differs is who may see it, and
// that difference is carried in two places on purpose — the tables (which no
// channel query touches) and the event's address (which no third console
// receives).
type DMService struct {
	repo *repository.DMRepository
	hub  *events.Hub
}

func NewDMService(repo *repository.DMRepository, hub *events.Hub) *DMService {
	return &DMService{repo: repo, hub: hub}
}

// publish tells one person that their conversation moved.
//
// Event.UserID, never a bare OrgID: the org-wide path would put a private
// message on every console in the organization and on every superadmin's
// stream. And the hub only, never emitItemEvent — that one dispatches the
// tenant's webhook, which is about as far outside this conversation as it gets.
//
// The author is not told about their own message; the actor rides along anyway
// so the receiving console can apply the same echo rule it uses everywhere.
func (s *DMService) publish(toUserID, conversationID, messageID, actorID string) {
	if s.hub == nil || toUserID == "" || toUserID == actorID {
		return
	}
	s.hub.Publish(events.Event{
		Type:   "dm:message",
		UserID: toUserID,
		Data: map[string]string{
			"conversationId": conversationID, "messageId": messageID, "actorId": actorID,
		},
	})
}

// OpenWith is how a conversation starts: there is no "create", only naming the
// person. Both directions resolve to the same row.
func (s *DMService) OpenWith(orgID, userID, otherID string) (*domain.DMConversation, error) {
	return s.repo.OpenWith(orgID, userID, otherID)
}

// mine loads a conversation and refuses it to anyone who is not in it.
//
// Not-found rather than forbidden, like the spaces: telling somebody that a
// conversation exists but isn't theirs is itself a fact about who talks to whom.
func (s *DMService) mine(conversationID, userID string) (*domain.DMConversation, error) {
	c, err := s.repo.FindConversation(conversationID)
	if err != nil {
		return nil, err
	}
	if !c.Includes(userID) {
		return nil, repository.ErrConversationNotFound
	}
	return c, nil
}

func (s *DMService) List(conversationID, userID string, before time.Time, limit int) ([]domain.DMMessageResponse, error) {
	if _, err := s.mine(conversationID, userID); err != nil {
		return nil, err
	}
	return s.repo.List(conversationID, before, limit)
}

func (s *DMService) Post(conversationID, userID, body string) (*domain.DMMessage, error) {
	c, err := s.mine(conversationID, userID)
	if err != nil {
		return nil, err
	}
	m := &domain.DMMessage{
		ConversationID: c.ID, OrgID: c.OrgID, AuthorUserID: userID, Body: body,
	}
	m.ID = uuid.NewString()
	if err := s.repo.Create(m); err != nil {
		return nil, err
	}
	s.publish(c.Other(userID), c.ID, m.ID, userID)
	return m, nil
}

func (s *DMService) Edit(conversationID, messageID, userID string, superadmin bool, body string) error {
	c, err := s.mine(conversationID, userID)
	if err != nil {
		return err
	}
	m, err := s.repo.Find(messageID)
	if err != nil {
		return err
	}
	// Belonging to the conversation is not enough: rewriting what the other
	// person said is not a thing either of them may do.
	if m.ConversationID != c.ID {
		return repository.ErrDMMessageNotFound
	}
	if m.AuthorUserID != userID && !superadmin {
		return ErrNotTheAuthor
	}
	if err := s.repo.UpdateBody(messageID, body); err != nil {
		return err
	}
	s.publish(c.Other(userID), c.ID, m.ID, userID)
	return nil
}

func (s *DMService) Withdraw(conversationID, messageID, userID string, superadmin bool) error {
	c, err := s.mine(conversationID, userID)
	if err != nil {
		return err
	}
	m, err := s.repo.Find(messageID)
	if err != nil {
		return err
	}
	if m.ConversationID != c.ID {
		return repository.ErrDMMessageNotFound
	}
	if m.AuthorUserID != userID && !superadmin {
		return ErrNotTheAuthor
	}
	if err := s.repo.Withdraw(messageID); err != nil {
		return err
	}
	s.publish(c.Other(userID), c.ID, m.ID, userID)
	return nil
}

func (s *DMService) MarkRead(conversationID, userID string) error {
	if _, err := s.mine(conversationID, userID); err != nil {
		return err
	}
	return s.repo.MarkRead(conversationID, userID)
}

func (s *DMService) Conversations(userID string, orgIDs []string) ([]domain.DMSummary, error) {
	return s.repo.Conversations(userID, orgIDs)
}
