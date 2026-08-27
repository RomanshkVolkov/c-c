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
	Notify(a domain.Aviso)
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
//
// Recibe un struct y ya no siete cadenas sueltas. Con nueve, `title`, `body`,
// `link`, `via`, `group` y `label` son todas del mismo tipo y el compilador deja
// pasar dos intercambiadas sin decir nada — un aviso que dice el cuerpo donde va
// el título llega a la campana de todo el mundo.
//
// El struct tiene su propio precio, y conviene nombrarlo: un literal que se
// olvide de `Group` compila igual, así que **un sitio nuevo que notifique
// produciría filas no agrupables en silencio**. De ahí la red de abajo.
func (s *NotificationService) Notify(a domain.Aviso) {
	if s == nil || s.repo == nil || a.UserID == "" {
		return
	}
	// Checked here rather than at every call site: the services that publish
	// events should not each have to remember what somebody wants, and one of
	// them forgetting would be a preference that silently does nothing.
	if prefs, err := s.repo.Prefs(a.UserID); err == nil && !prefs.Allows(a.Kind) {
		return
	}
	// La red: si quien llama no puso clave, se deduce de la clase y el enlace.
	// Un sitio olvidadizo produce una fila agrupable igualmente, y si su enlace
	// no tiene forma conocida se queda suelta — como antes de que esto
	// existiera. Nunca acaba en el grupo de otro.
	group := a.Group
	if group == "" {
		group = domain.DeriveGroup(a.Kind, a.Link)
	}
	n := &domain.Notification{
		UserID: a.UserID, OrgID: a.OrgID, Kind: a.Kind,
		Title: a.Title, Body: a.Body, Link: a.Link,
		Via:        domain.NormalizeVia(a.Via),
		GroupKey:   group,
		GroupLabel: a.Label,
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
