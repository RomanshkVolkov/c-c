package service

import (
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Notifier is the small slice of the inbox that other services need: the
// ability to leave somebody a note. Declared as an interface so chat and DMs
// depend on the act and not on the store, and so a service constructed without
// one simply doesn't record — which is what every existing test does.
type Notifier interface {
	Notify(userID, orgID, kind, title, body, link, via string)
}

type NotificationService struct {
	repo *repository.NotificationRepository
}

func NewNotificationService(repo *repository.NotificationRepository) *NotificationService {
	return &NotificationService{repo: repo}
}

// Notify records one. Errors are swallowed on purpose: failing to write the
// inbox row must never fail the message that caused it — being told late is a
// nuisance, not being able to speak is a fault.
// `via` es por dónde entró la acción; ver domain/via.go. Es un parámetro y no
// un campo del contexto porque el compilador no se olvida de los parámetros: si
// mañana otra cosa escribe notificaciones, tiene que contestar de dónde viene.
func (s *NotificationService) Notify(userID, orgID, kind, title, body, link, via string) {
	if s == nil || s.repo == nil || userID == "" {
		return
	}
	// Checked here rather than at every call site: the services that publish
	// events should not each have to remember what somebody wants, and one of
	// them forgetting would be a preference that silently does nothing.
	if prefs, err := s.repo.Prefs(userID); err == nil && !prefs.Allows(kind) {
		return
	}
	n := &domain.Notification{
		UserID: userID, OrgID: orgID, Kind: kind, Title: title, Body: body, Link: link,
		Via: domain.NormalizeVia(via),
	}
	_ = s.repo.Add(n)
}

func (s *NotificationService) Feed(userID, orgID string, limit int) (domain.NotificationFeed, error) {
	return s.repo.Feed(userID, orgID, limit)
}

func (s *NotificationService) Prefs(userID string) (domain.NotificationPrefs, error) {
	return s.repo.Prefs(userID)
}

func (s *NotificationService) SavePrefs(p domain.NotificationPrefs) error {
	return s.repo.SavePrefs(p)
}

func (s *NotificationService) MarkRead(userID string, ids []string) error {
	return s.repo.MarkRead(userID, ids)
}

func (s *NotificationService) MarkAllRead(userID, orgID string) error {
	return s.repo.MarkAllRead(userID, orgID)
}
