package service

import (
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
)

// Un agente que avisa a la persona de su token (#153): «paré porque hay una
// decisión», «terminé el deploy». Llega como cualquier otro aviso —fila en la
// campana, teléfono y aviso del sistema— y **sólo a esa persona**: el
// destinatario sale de quién llama, nunca de lo que manda.

var (
	// ErrNoticeOrgAmbiguous: está en varias organizaciones y no dijo en cuál.
	ErrNoticeOrgAmbiguous = errors.New("pick-an-org")
	// ErrNoticeOrgNotMine: pidió una organización en la que no está.
	ErrNoticeOrgNotMine = errors.New("not-a-member")
	ErrNoticeLink       = errors.New("link-must-be-internal")
	ErrNoticeTooMany    = errors.New("too-many-notices")
)

// selfNoticeLimit avisos por persona cada selfNoticeWindow. Un agente metido
// en un bucle no puede convertir la campana y el teléfono de alguien en una
// sirena; uno normal avisa un par de veces por tarea.
const (
	selfNoticeLimit  = 10
	selfNoticeWindow = 10 * time.Minute
)

type SelfNoticeService struct {
	hub     *events.Hub
	inbox   Notifier
	orgName func(id string) string
	now     func() time.Time

	mu   sync.Mutex
	sent map[string][]time.Time
}

func NewSelfNoticeService(hub *events.Hub, inbox Notifier, orgName func(string) string) *SelfNoticeService {
	return &SelfNoticeService{hub: hub, inbox: inbox, orgName: orgName, now: time.Now, sent: map[string][]time.Time{}}
}

// ResolveNoticeOrg: la organización del aviso. La que pidió, si es suya; si no
// pidió ninguna, la única en la que está. Con varias, ninguna: elegir una al
// azar dejaría el aviso en una campana que no está mirando.
func ResolveNoticeOrg(requested string, mine []domain.OrgMembershipClaim) (string, error) {
	if requested != "" {
		for _, m := range mine {
			if m.OrgID == requested {
				return requested, nil
			}
		}
		return "", ErrNoticeOrgNotMine
	}
	if len(mine) == 1 {
		return mine[0].OrgID, nil
	}
	return "", ErrNoticeOrgAmbiguous
}

// Orgs: entre cuáles puede elegir, para el error de «¿en cuál?».
func (s *SelfNoticeService) Orgs(mine []domain.OrgMembershipClaim) []domain.SelfNoticeOrg {
	out := make([]domain.SelfNoticeOrg, 0, len(mine))
	for _, m := range mine {
		o := domain.SelfNoticeOrg{ID: m.OrgID}
		if s.orgName != nil {
			o.Name = s.orgName(m.OrgID)
		}
		out = append(out, o)
	}
	return out
}

// allow apunta un aviso si cabe en la ventana.
func (s *SelfNoticeService) allow(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	keep := s.sent[userID][:0]
	for _, t := range s.sent[userID] {
		if now.Sub(t) < selfNoticeWindow {
			keep = append(keep, t)
		}
	}
	if len(keep) >= selfNoticeLimit {
		s.sent[userID] = keep
		return false
	}
	s.sent[userID] = append(keep, now)
	return true
}

// Send avisa a `claims` —y a nadie más— de lo que manda su agente.
// Devuelve en qué organización cayó.
func (s *SelfNoticeService) Send(claims *domain.ClaimsJWT, via string, req domain.SelfNoticeRequest) (string, error) {
	link := strings.TrimSpace(req.Link)
	if link == "" {
		link = "/"
	}
	if !domain.InternalLink(link) {
		return "", ErrNoticeLink
	}
	orgID, err := ResolveNoticeOrg(req.OrgID, claims.Orgs)
	if err != nil {
		return "", err
	}
	if !s.allow(claims.UserID) {
		return "", ErrNoticeTooMany
	}
	title, body := strings.TrimSpace(req.Title), strings.TrimSpace(req.Body)
	// El evento, dirigido a una persona como el timbre: lo pinta la app
	// abierta (aviso en pantalla y del sistema).
	if s.hub != nil {
		s.hub.Publish(events.Event{
			Type: domain.SelfNoticeKind, OrgID: orgID, UserID: claims.UserID,
			Data: map[string]string{"title": title, "body": body, "link": link},
		})
	}
	// La fila y el teléfono.
	if s.inbox != nil {
		s.inbox.Notify(domain.Aviso{
			UserID: claims.UserID, OrgID: orgID, Kind: domain.SelfNoticeKind,
			Title: title, Body: body, Link: link, Via: via,
			// Sin rótulo: la campana pinta el título del más nuevo y la marca de
			// agente (`via`), y un rótulo fijo sería texto en un solo idioma.
			Group: domain.SelfNoticeGroup(claims.UserID),
		})
	}
	return orgID, nil
}
