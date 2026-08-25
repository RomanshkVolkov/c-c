package service

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// El aviso de una reunión dura un minuto en pantalla.
//
// Más que el timbre de una llamada —veinte segundos— porque nadie está
// esperando este: una llamada la acabas de pedir tú, y una reunión periódica te
// pilla escribiendo. Menos que cinco minutos porque a los cinco ya estás en
// ella o ya no vas.
const meetingRingTTL = time.Minute

// graciaDelDisparo: cuánto retraso sigue mereciendo un timbre. Ver `vencida`.
const graciaDelDisparo = 5 * time.Minute

var ErrMeetingNoSpace = errors.New("that room belongs to another organization")

type MeetingService struct {
	repo   *repository.MeetingRepository
	orgs   *repository.OrganizationRepository
	spaces *repository.TaskRepository
	// inbox y hub son opcionales, como en el resto de servicios: sin ellos la
	// reunión se guarda igual y simplemente no avisa. Es lo que permite probar
	// la lógica sin montar media aplicación.
	inbox Notifier
	hub   *events.Hub
}

func NewMeetingService(
	repo *repository.MeetingRepository,
	orgs *repository.OrganizationRepository,
	spaces *repository.TaskRepository,
	inbox Notifier,
	hub *events.Hub,
) *MeetingService {
	return &MeetingService{repo: repo, orgs: orgs, spaces: spaces, inbox: inbox, hub: hub}
}

// zonaDe valida la zona y la devuelve. Es la única puerta por la que entra una
// zona horaria al sistema, así que una inválida se rechaza aquí y no cuando
// falte media hora para la reunión.
func zonaDe(nombre string) (*time.Location, error) {
	loc, err := time.LoadLocation(nombre)
	if err != nil {
		return nil, ErrBadTimezone
	}
	return loc, nil
}

// salaDeLaOrg comprueba que la sala asignada sea de esta organización.
//
// Sin esto, una reunión podría llevar a la gente a la sala de otro cliente: el
// botón «entrar» del aviso no vuelve a preguntar.
func (s *MeetingService) salaDeLaOrg(orgID, spaceID string) error {
	if spaceID == "" {
		return nil
	}
	sp, err := s.spaces.FindSpace(spaceID)
	if err != nil {
		return ErrMeetingNoSpace
	}
	if sp.OrgID != orgID {
		return ErrMeetingNoSpace
	}
	return nil
}

func (s *MeetingService) Create(orgID, creador string, req domain.CreateMeetingRequest) (*domain.MeetingReminder, error) {
	loc, err := zonaDe(req.Timezone)
	if err != nil {
		return nil, err
	}
	if err := s.salaDeLaOrg(orgID, req.SpaceID); err != nil {
		return nil, err
	}

	m := &domain.MeetingReminder{
		OrgID: orgID, Title: req.Title,
		WallTime: req.WallTime, Timezone: req.Timezone,
		Freq: req.Freq, Interval: req.Interval, Weekdays: req.Weekdays,
		MonthDay: req.MonthDay, Anchor: req.Anchor,
		CreatedBy: creador,
	}
	if m.Interval <= 0 {
		m.Interval = 1
	}
	if req.SpaceID != "" {
		m.SpaceID = &req.SpaceID
	}
	// La primera ocurrencia se calcula ya: valida la regla entera —hora, días,
	// frecuencia— antes de guardar nada, así que una reunión imposible se
	// rechaza en el formulario y no callándose para siempre.
	proxima, err := nextOccurrence(*m, time.Now(), loc)
	if err != nil {
		return nil, err
	}
	m.NextFireAt = proxima
	m.ID = uuid.NewString()

	if err := s.repo.Create(m); err != nil {
		return nil, err
	}
	return m, nil
}

// Update aplica sólo lo que llegó, y **siempre recalcula** la próxima ocurrencia.
//
// Lo segundo no es opcional: `next_fire_at` es el testigo con el que las dos
// réplicas se reparten el turno. Dejarlo apuntando a una hora que ya no
// corresponde haría sonar la reunión a la hora vieja una última vez.
func (s *MeetingService) Update(id string, req domain.UpdateMeetingRequest) (*domain.MeetingReminder, error) {
	m, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}

	campos := map[string]any{}
	if req.Title != nil {
		m.Title = *req.Title
		campos["title"] = m.Title
	}
	if req.WallTime != nil {
		m.WallTime = *req.WallTime
		campos["wall_time"] = m.WallTime
	}
	if req.Timezone != nil {
		m.Timezone = *req.Timezone
		campos["timezone"] = m.Timezone
	}
	if req.Freq != nil {
		m.Freq = *req.Freq
		campos["freq"] = m.Freq
	}
	if req.Interval != nil && *req.Interval > 0 {
		m.Interval = *req.Interval
		campos["interval"] = m.Interval
	}
	if req.Weekdays != nil {
		m.Weekdays = *req.Weekdays
		campos["weekdays"] = m.Weekdays
	}
	if req.MonthDay != nil {
		m.MonthDay = *req.MonthDay
		campos["month_day"] = m.MonthDay
	}
	if req.Anchor != nil {
		m.Anchor = *req.Anchor
		campos["anchor"] = m.Anchor
	}
	if req.SpaceID != nil {
		if err := s.salaDeLaOrg(m.OrgID, *req.SpaceID); err != nil {
			return nil, err
		}
		if *req.SpaceID == "" {
			m.SpaceID = nil
			campos["space_id"] = nil
		} else {
			sala := *req.SpaceID
			m.SpaceID = &sala
			campos["space_id"] = sala
		}
	}
	if req.Paused != nil {
		m.Paused = *req.Paused
		campos["paused"] = m.Paused
	}
	if len(campos) == 0 {
		return m, nil
	}

	loc, err := zonaDe(m.Timezone)
	if err != nil {
		return nil, err
	}
	proxima, err := nextOccurrence(*m, time.Now(), loc)
	if err != nil {
		return nil, err
	}
	m.NextFireAt = proxima
	campos["next_fire_at"] = proxima

	if err := s.repo.Save(id, campos); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *MeetingService) Delete(id string) error { return s.repo.Delete(id) }

func (s *MeetingService) Find(id string) (*domain.MeetingReminder, error) {
	return s.repo.FindByID(id)
}

func (s *MeetingService) SetExcluded(id string, userIDs []string) error {
	return s.repo.SetExcluded(id, userIDs)
}

// List devuelve la agenda con lo que la pantalla necesita y no está en la fila.
func (s *MeetingService) List(orgID string) ([]domain.MeetingResponse, error) {
	reuniones, err := s.repo.ListByOrg(orgID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.MeetingResponse, len(reuniones))
	for i, m := range reuniones {
		excluidos, _ := s.repo.Excluded(m.ID)
		if excluidos == nil {
			excluidos = []string{}
		}
		out[i] = domain.MeetingResponse{MeetingReminder: m, ExcludedUserIDs: excluidos}
		if m.SpaceID != nil {
			if sp, err := s.spaces.FindSpace(*m.SpaceID); err == nil {
				out[i].SpaceName = sp.Name
			}
		}
	}
	return out, nil
}

// Agenda expande las reuniones en sus ocurrencias concretas de una ventana.
//
// Las pausadas van incluidas y **marcadas**: quitarlas del calendario haría
// que una reunión pausada por error fuera invisible justo en la pantalla donde
// se iría a buscarla.
func (s *MeetingService) Agenda(orgID string, desde time.Time, dias int) ([]domain.MeetingOccurrence, error) {
	if dias <= 0 || dias > 120 {
		dias = 60
	}
	hasta := desde.AddDate(0, 0, dias)

	reuniones, err := s.repo.ListByOrg(orgID)
	if err != nil {
		return nil, err
	}
	out := []domain.MeetingOccurrence{}
	for _, m := range reuniones {
		loc, err := zonaDe(m.Timezone)
		if err != nil {
			continue
		}
		base := domain.MeetingOccurrence{
			MeetingID: m.ID, Title: m.Title, Timezone: m.Timezone, Paused: m.Paused,
		}
		if m.SpaceID != nil {
			base.SpaceID = *m.SpaceID
			if sp, err := s.spaces.FindSpace(*m.SpaceID); err == nil {
				base.SpaceName = sp.Name
			}
		}
		// Un tope por reunión: una diaria a dos meses son sesenta filas, y
		// varias diarias no pueden convertir esto en miles.
		for _, cuando := range occurrencesBetween(m, desde, hasta, loc, dias+1) {
			ocurrencia := base
			ocurrencia.At = cuando
			out = append(out, ocurrencia)
		}
	}
	return out, nil
}

// ─── El disparo ─────────────────────────────────────────────────────────────

// destinatarios: todos los de la organización menos quien pidió no recibirla.
//
// Se resta en vez de sumar porque lo que se guarda son las exclusiones: quien
// entra en la organización queda convocado sin que nadie tenga que acordarse
// de añadirlo.
func destinatarios(miembros, excluidos []string) []string {
	fuera := make(map[string]bool, len(excluidos))
	for _, uid := range excluidos {
		fuera[uid] = true
	}
	out := make([]string, 0, len(miembros))
	vistos := map[string]bool{}
	for _, uid := range miembros {
		if uid == "" || fuera[uid] || vistos[uid] {
			continue
		}
		vistos[uid] = true
		out = append(out, uid)
	}
	return out
}

// FireDue mira qué reuniones vencieron y anuncia las que toca.
//
// Lo llama el reloj de fondo cada pocos segundos, en **las dos réplicas a la
// vez**. Que sólo suene una vez lo garantiza `repo.Reservar`, no este código:
// aquí se intenta y se sigue.
func (s *MeetingService) FireDue(now time.Time) {
	vencidas, err := s.repo.Due(now)
	if err != nil {
		return
	}
	for _, m := range vencidas {
		loc, err := zonaDe(m.Timezone)
		if err != nil {
			// Zona ilegible: no se puede calcular nada, y reintentarlo cada
			// treinta segundos para siempre tampoco arregla nada. Se deja como
			// está; la reunión no suena y el admin la verá parada en su hora.
			continue
		}
		proxima, err := nextOccurrence(m, now, loc)
		if err != nil {
			continue
		}

		// Tarde de más —el proceso estuvo caído— se pone en hora sin avisar de
		// una reunión que ya pasó.
		if !vencida(m.NextFireAt, now, graciaDelDisparo) {
			_, _ = s.repo.Reprogramar(m.ID, m.NextFireAt, proxima)
			continue
		}

		mio, err := s.repo.Reservar(m.ID, m.NextFireAt, proxima, now)
		if err != nil || !mio {
			continue // la otra réplica se lo quedó
		}
		s.anunciar(m, now)
	}
}

// anunciar reparte el aviso: la tarjeta que suena y la fila en la campana.
func (s *MeetingService) anunciar(m domain.MeetingReminder, now time.Time) {
	aviso := domain.MeetingRing{
		MeetingID: m.ID, Title: m.Title,
		WallTime: m.WallTime, Timezone: m.Timezone,
		FiresAt: now, ExpiresAt: now.Add(meetingRingTTL),
	}
	enlace := "/"
	if m.SpaceID != nil {
		aviso.SpaceID = *m.SpaceID
		if sp, err := s.spaces.FindSpace(*m.SpaceID); err == nil {
			aviso.SpaceName = sp.Name
		}
		enlace = "/chat?space=" + *m.SpaceID
	}

	miembros, err := s.orgs.MemberIDs(m.OrgID)
	if err != nil {
		return
	}
	excluidos, _ := s.repo.Excluded(m.ID)

	cuerpo := "Starting now"
	if aviso.SpaceName != "" {
		cuerpo = "Starting now in #" + aviso.SpaceName
	}

	for _, uid := range destinatarios(miembros, excluidos) {
		// Dirigido a una persona, como el timbre de una llamada: `UserID`
		// estrecha la entrega en el hub, así que no viaja a quien se excluyó ni
		// aunque comparta organización.
		if s.hub != nil {
			s.hub.Publish(events.Event{
				Type: "meeting:reminder", OrgID: m.OrgID, UserID: uid, Data: aviso,
			})
		}
		if s.inbox != nil {
			s.inbox.Notify(uid, m.OrgID, "meeting:reminder", m.Title, cuerpo, enlace, "")
		}
	}
}
