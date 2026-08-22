package service

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
)

// ErrRingOutsider: llamar a alguien que no está en esta organización.
//
// Se distingue de «no existe» porque la respuesta es distinta: quien llama
// eligió a esa persona de una lista, así que si la respuesta fuera 404 la
// pantalla diría «no encontrado» de alguien que está viendo delante.
var ErrRingOutsider = errors.New("that person is not in this organization")

// TimbreTTL es cuánto suena un timbre antes de rendirse.
//
// Veinte segundos porque es el tiempo en el que alguien que está delante de la
// pantalla contesta, y el doble de lo que aguanta alguien que no. Sin un tope,
// un timbre que nadie recoge suena hasta que se cierra la app — y quien llamó
// ya se fue a hacer otra cosa.
const TimbreTTL = 20 * time.Second

// Timbrar hace sonar el teléfono de una persona para que entre a esta sala.
//
// Dos comprobaciones y ninguna más: que quien llama pertenezca a la
// organización del espacio —eso ya lo hizo el handler al resolverlo— y que a
// quien llama también. La segunda es la que impide convertir esto en un
// pulsador para molestar a cualquiera cuyo id se conozca.
//
// El aviso va **dirigido a una persona**, no a la organización. El hub sabe
// hacerlo (`Event.UserID`), y es lo que hace que el teléfono suene en un solo
// sitio en vez de en todos los escritorios del equipo.
func (s *TaskService) Timbrar(sp *domain.TaskSpace, de domain.VoiceCaller, aUserID string) (*domain.VoiceRing, error) {
	if aUserID == "" || aUserID == de.ID {
		// Llamarse a uno mismo no es un error del servidor, pero tampoco es
		// nada: sonaría en el propio escritorio desde el que se pulsó.
		return nil, ErrRingOutsider
	}
	if _, err := s.orgs.GetMembership(sp.OrgID, aUserID); err != nil {
		return nil, ErrRingOutsider
	}

	timbre := &domain.VoiceRing{
		RingID:    uuid.NewString(),
		SpaceID:   sp.ID,
		SpaceName: sp.Name,
		From:      de,
		ExpiresAt: time.Now().UTC().Add(TimbreTTL),
	}
	if s.hub != nil {
		s.hub.Publish(events.Event{
			Type:   "voice.ring",
			OrgID:  sp.OrgID,
			UserID: aUserID,
			Data:   timbre,
		})
	}
	return timbre, nil
}

// CancelarTimbre calla el teléfono de quien todavía no ha contestado.
//
// Mismo guard: sólo se puede dejar de llamar a alguien de esta organización,
// que es la única a la que se le pudo llamar. Y sólo se cancela **el propio**
// timbre —el evento lleva quién llamaba, y la app de destino sólo se calla si
// coincide— para que un id de más no sirva para colgarle la llamada a otro.
func (s *TaskService) CancelarTimbre(sp *domain.TaskSpace, deUserID, aUserID string) error {
	if aUserID == "" || aUserID == deUserID {
		return ErrRingOutsider
	}
	if _, err := s.orgs.GetMembership(sp.OrgID, aUserID); err != nil {
		return ErrRingOutsider
	}
	if s.hub != nil {
		s.hub.Publish(events.Event{
			Type:   "voice.ring.cancel",
			OrgID:  sp.OrgID,
			UserID: aUserID,
			Data:   &domain.VoiceRingCancel{SpaceID: sp.ID, From: deUserID},
		})
	}
	return nil
}
