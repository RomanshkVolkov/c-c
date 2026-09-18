package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	lksdk "github.com/livekit/protocol/livekit"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	// ErrRecordingsDisabled: esta instalación no graba. No es un fallo.
	ErrRecordingsDisabled = errors.New("recordings are not enabled")
	// ErrRoomEmpty: grabar una sala vacía guardaría un fichero de silencio y
	// dejaría el chip REC encendido para nadie.
	ErrRoomEmpty = errors.New("nobody is in the call")
)

// RecordingService: empezar, parar y —sobre todo— el tick que descubre pistas.
//
// La parte que no se ve es la que manda: **nadie avisa de que alguien entró a
// la llamada**. No hay webhooks; el reloj pregunta. Por eso un participante que
// llega tarde tarda hasta un tick en empezar a grabarse, y por eso el tick es
// de diez segundos y no de treinta: en treinta cabe un «hola, ¿me oyes?»
// entero.
type RecordingService struct {
	repo   *repository.RecordingRepository
	lk     lkclient.Client
	hub    *events.Hub
	prefix string
	// enabled es el interruptor de configuración. Separado de `lk == nil` para
	// que se pueda apagar la grabación sin apagar la voz.
	enabled    bool
	maxMinutes int
	// storeReady dice si hay bucket. Sin él, Egress escribiría en un sitio que
	// nadie puede leer después.
	storeReady bool
}

func NewRecordingService(
	repo *repository.RecordingRepository, lk lkclient.Client, hub *events.Hub,
	prefix string, enabled, storeReady bool, maxMinutes int,
) *RecordingService {
	if prefix == "" {
		prefix = domain.RecordingPrefixDefault
	}
	if maxMinutes <= 0 {
		maxMinutes = 240
	}
	return &RecordingService{
		repo: repo, lk: lk, hub: hub, prefix: prefix,
		enabled: enabled, storeReady: storeReady, maxMinutes: maxMinutes,
	}
}

// Enabled: las tres condiciones. Si falta una, la app esconde el botón en vez
// de enseñar uno que siempre falla.
func (s *RecordingService) Enabled() bool {
	return s != nil && s.enabled && s.lk != nil && s.storeReady
}

// ─── Empezar y parar ─────────────────────────────────────────────────────────

// Start abre la grabación de la sala de un espacio.
//
// Comprueba que hay alguien dentro **antes** de insertar: una grabación de una
// sala vacía dejaría el chip REC encendido para nadie y un fichero de silencio.
// El choque contra el índice único es la otra guarda, y ésa sí es a prueba de
// carreras — dos personas pulsando a la vez son dos INSERT en vuelo.
func (s *RecordingService) Start(ctx context.Context, orgID, spaceID, userID string) (*domain.Recording, error) {
	if !s.Enabled() {
		return nil, ErrRecordingsDisabled
	}
	room := RoomFor(spaceID)

	people, err := s.lk.Participants(ctx, room)
	if err != nil {
		return nil, err
	}
	if humans(people) == 0 {
		return nil, ErrRoomEmpty
	}

	now := time.Now().UTC()
	rec := &domain.Recording{
		BaseModel: domain.BaseModel{ID: uuid.NewString()},
		OrgID:     orgID, SpaceID: spaceID, Room: room, StartedBy: userID,
		Status: domain.RecordingActive, StartedAt: now, TickedAt: now,
	}
	if err := s.repo.Create(rec); err != nil {
		return nil, err
	}

	// El tick va aquí y en línea, no en el siguiente latido: quien pulsa
	// «grabar» espera que su propio micro entre ya, y diez segundos de su voz
	// perdidos es lo primero que se nota.
	s.tickOne(ctx, rec, now)

	s.markRoom(ctx, rec)
	s.publish(rec)
	return rec, nil
}

// Stop cierra la grabación: los egress paran y el chip REC se apaga.
//
// `reason` no es cosmético: distingue «alguien lo pidió» de «la sala se quedó
// vacía» y de «se llegó al tope», que es lo que uno quiere saber al mirar por
// qué se cortó una reunión.
func (s *RecordingService) Stop(ctx context.Context, rec *domain.Recording, reason string) error {
	now := time.Now().UTC()
	ok, err := s.repo.Transition(rec.ID, domain.RecordingActive, domain.RecordingFinalizing,
		map[string]any{"ended_at": now})
	if err != nil {
		return err
	}
	if !ok {
		// Otra réplica —o el botón pulsado dos veces— llegó antes. Parar es
		// idempotente a propósito: es lo que uno espera de un botón de colgar.
		return nil
	}
	rec.Status = domain.RecordingFinalizing
	rec.EndedAt = &now

	live, err := s.repo.LiveTracks(rec.ID)
	if err != nil {
		return err
	}
	for _, t := range live {
		if t.EgressID == "" {
			continue
		}
		if _, err := s.lk.StopEgress(ctx, rec.Room, t.EgressID); err != nil {
			// «not found» es lo normal cuando la pista ya acabó sola —alguien
			// dejó de compartir pantalla— y no es un fallo de nada.
			lg.Warn("recording: stopping egress " + t.EgressID + ": " + err.Error())
		}
	}

	lg.Info("recording " + rec.ID + " stopped (" + reason + ")")
	s.markRoom(ctx, rec)
	s.publish(rec)
	return nil
}

// ─── El reloj ────────────────────────────────────────────────────────────────

// Tick reconcilia todas las grabaciones vivas.
//
// Corre en las dos réplicas a la vez y está bien: quién se queda cada grabación
// lo decide la base con `ClaimTick`, no este bucle.
func (s *RecordingService) Tick(ctx context.Context, now time.Time) {
	if !s.Enabled() {
		return
	}
	live, err := s.repo.Unfinished()
	if err != nil {
		lg.Error("recording: cannot list the live ones: " + err.Error())
		return
	}
	for i := range live {
		rec := &live[i]
		claimed, err := s.repo.ClaimTick(rec.ID, rec.TickedAt, now)
		if err != nil {
			lg.Error("recording: tick witness for " + rec.ID + ": " + err.Error())
			continue
		}
		if !claimed {
			continue // la otra réplica se lo quedó
		}
		s.tickOne(ctx, rec, now)
	}
}

func (s *RecordingService) tickOne(ctx context.Context, rec *domain.Recording, now time.Time) {
	people := []*lksdk.ParticipantInfo(nil)
	if rec.Status == domain.RecordingActive {
		var err error
		people, err = s.lk.Participants(ctx, rec.Room)
		if err != nil {
			// Una sala que ya no existe es una sala vacía: el SFU la tira
			// cuando se va el último, y eso es exactamente lo que queremos
			// detectar. Tratarlo como error dejaría la grabación abierta para
			// siempre.
			lg.Warn("recording: " + rec.Room + " does not answer: " + err.Error())
			people = nil
		}
		s.discover(ctx, rec, people)
	}

	s.reconcile(ctx, rec, now)

	if rec.Status != domain.RecordingActive {
		return
	}

	// La sala vacía para la grabación, y no se espera al `empty_timeout` del
	// SFU (cinco minutos): eso serían cinco minutos de silencio grabado. Dos
	// ticks seguidos y no uno, para que una reconexión de diez segundos no
	// corte la reunión de nadie.
	if humans(people) == 0 {
		rec.EmptyTicks++
		if err := s.repo.SetEmptyTicks(rec.ID, rec.EmptyTicks); err != nil {
			lg.Error("recording: counting empty ticks: " + err.Error())
		}
		if rec.EmptyTicks >= 2 {
			if err := s.Stop(ctx, rec, "empty"); err != nil {
				lg.Error("recording: stopping an empty room: " + err.Error())
			}
			return
		}
	} else if rec.EmptyTicks != 0 {
		rec.EmptyTicks = 0
		if err := s.repo.SetEmptyTicks(rec.ID, 0); err != nil {
			lg.Error("recording: resetting the empty-tick count: " + err.Error())
		}
	}

	if now.Sub(rec.StartedAt) > time.Duration(s.maxMinutes)*time.Minute {
		if err := s.Stop(ctx, rec, "max-duration"); err != nil {
			lg.Error("recording: stopping at the time cap: " + err.Error())
		}
	}
}

// discover arranca un egress por cada pista nueva que merezca grabarse.
func (s *RecordingService) discover(ctx context.Context, rec *domain.Recording, people []*lksdk.ParticipantInfo) {
	for _, p := range people {
		if p.Kind != lksdk.ParticipantInfo_STANDARD {
			continue // el propio grabador, agentes, SIP
		}
		for _, t := range p.Tracks {
			if !domain.Recordable(t.Source.String()) {
				continue // aquí es donde se quedan las cámaras
			}
			// **Una pista muteada se graba igual.** Un mute no cambia el sid, y
			// saltarla obligaría a detectar el unmute y perder los primeros
			// segundos de quien vuelve a hablar. El `.ogg` de una pista muda
			// pesa casi nada: sin paquetes no hay fichero que llenar.
			track := &domain.RecordingTrack{
				BaseModel:           domain.BaseModel{ID: uuid.NewString()},
				RecordingID:         rec.ID,
				TrackSid:            t.Sid,
				ParticipantIdentity: p.Identity,
				Source:              t.Source.String(),
				MimeType:            strings.ToLower(t.MimeType),
				Status:              domain.TrackStarting,
			}
			mine, err := s.repo.ClaimTrack(track)
			if err != nil {
				lg.Error("recording: claiming track " + t.Sid + ": " + err.Error())
				continue
			}
			if !mine {
				continue // ya la está grabando alguien (otra réplica, o este mismo reloj antes)
			}
			s.startTrack(ctx, rec, track)
		}
	}
}

func (s *RecordingService) startTrack(ctx context.Context, rec *domain.Recording, t *domain.RecordingTrack) {
	key := domain.RecordingTrackKey(s.prefix, rec.OrgID, rec.SpaceID, rec.ID,
		t.Source, t.ParticipantIdentity, t.TrackSid)
	info, err := s.lk.StartTrackEgress(ctx, rec.Room, t.TrackSid, key)
	if err != nil {
		lg.Error("recording: starting the egress for " + t.TrackSid + ": " + err.Error())
		s.saveTrack(t.ID, map[string]any{
			"status": domain.TrackFailed, "attempts": t.Attempts + 1,
			"error": truncate(err.Error()),
		})
		return
	}
	s.saveTrack(t.ID, map[string]any{
		"status": domain.TrackActive, "egress_id": info.EgressId,
		"attempts": t.Attempts + 1,
	})
}

// reconcile pregunta al SFU cómo van los egress y cierra lo que ya acabó.
//
// Una sola llamada para toda la sala: preguntar por cada egress sería una
// llamada por pista, y con seis personas más una pantalla eso son siete por
// tick.
func (s *RecordingService) reconcile(ctx context.Context, rec *domain.Recording, now time.Time) {
	live, err := s.repo.LiveTracks(rec.ID)
	if err != nil {
		lg.Error("recording: listing live tracks: " + err.Error())
		return
	}
	if len(live) > 0 {
		known := map[string]*lksdk.EgressInfo{}
		items, err := s.lk.ListEgress(ctx, rec.Room)
		if err != nil {
			// Sin respuesta no se decide nada: dar por muertas las pistas
			// porque el SFU tardó sería tirar una grabación en curso.
			lg.Warn("recording: listing egress in " + rec.Room + ": " + err.Error())
			return
		}
		for _, it := range items {
			known[it.EgressId] = it
		}
		for i := range live {
			s.reconcileTrack(&live[i], known)
		}
	}

	// ¿Queda alguna moviéndose? Se vuelve a preguntar porque el bucle de arriba
	// acaba de cambiar estados.
	remaining, err := s.repo.LiveTracks(rec.ID)
	if err != nil {
		lg.Error("recording: re-counting live tracks: " + err.Error())
		return
	}
	all, err := s.repo.Tracks(rec.ID)
	if err != nil {
		lg.Error("recording: listing tracks: " + err.Error())
		return
	}
	s.setFirstMedia(rec, all)

	if len(remaining) > 0 || rec.Status != domain.RecordingFinalizing || rec.EgressDoneAt != nil {
		return
	}

	// Ninguna pista se mueve ya: los ficheros están cerrados en S3 y el mux
	// puede montar. Hasta este momento un multipart podía estar a medio subir,
	// y sólo `EGRESS_COMPLETE` sabe que terminó.
	done := 0
	for _, t := range all {
		if t.Status == domain.TrackComplete {
			done++
		}
	}
	if done == 0 {
		if _, err := s.repo.Transition(rec.ID, domain.RecordingFinalizing, domain.RecordingFailed,
			map[string]any{"error": "no media"}); err != nil {
			lg.Error("recording: marking it as having no media: " + err.Error())
			return
		}
		rec.Status = domain.RecordingFailed
		s.publish(rec)
		return
	}
	if _, err := s.repo.Transition(rec.ID, domain.RecordingFinalizing, domain.RecordingFinalizing,
		map[string]any{"egress_done_at": now}); err != nil {
		lg.Error("recording: closing the egress phase: " + err.Error())
		return
	}
	rec.EgressDoneAt = &now
}

// reconcileTrack traduce lo que dice el SFU al estado de una pista.
func (s *RecordingService) reconcileTrack(t *domain.RecordingTrack, known map[string]*lksdk.EgressInfo) {
	info, seen := known[t.EgressID]
	if !seen {
		// Un egress que el SFU ya no conoce es, casi siempre, el pod de Egress
		// reiniciado: el bus no tiene persistencia, así que al volver no sabe
		// nada de lo que estaba haciendo. Tres ticks antes de darla por perdida
		// para no confundirlo con una respuesta incompleta.
		if t.MissingTicks+1 >= 3 {
			s.saveTrack(t.ID, map[string]any{
				"status": domain.TrackFailed, "missing_ticks": t.MissingTicks + 1,
				"error": "egress vanished",
			})
			return
		}
		s.saveTrack(t.ID, map[string]any{"missing_ticks": t.MissingTicks + 1})
		return
	}

	switch info.Status {
	case lksdk.EgressStatus_EGRESS_COMPLETE:
		fields := map[string]any{"status": domain.TrackComplete, "missing_ticks": 0}
		if len(info.FileResults) > 0 {
			f := info.FileResults[0]
			// La clave buena es la que Egress **escribió**, no la que se pidió:
			// la extensión la pone él según el códec real.
			fields["object_key"] = f.Filename
			fields["bytes"] = f.Size
			// Nanosegundos Unix. Éste es el ancla con la que el mux pega las
			// pistas — medido en la fase 0: dos egress arrancados con 5,8 s de
			// diferencia siguen alineando dentro de 73 ms por aquí.
			if f.StartedAt > 0 {
				fields["started_at"] = time.Unix(0, f.StartedAt).UTC()
			}
			if f.EndedAt > 0 {
				fields["ended_at"] = time.Unix(0, f.EndedAt).UTC()
			}
		}
		s.saveTrack(t.ID, fields)
	case lksdk.EgressStatus_EGRESS_FAILED, lksdk.EgressStatus_EGRESS_ABORTED,
		lksdk.EgressStatus_EGRESS_LIMIT_REACHED:
		msg := info.Error
		if msg == "" {
			msg = info.Status.String()
		}
		s.saveTrack(t.ID, map[string]any{
			"status": domain.TrackFailed, "missing_ticks": 0, "error": truncate(msg),
		})
	default:
		// STARTING, ACTIVE y **ENDING**. `ENDING` no es terminal: el fichero
		// todavía se está cerrando, y tratarlo como acabado pondría al mux a
		// montar un multipart a medias.
		if t.MissingTicks != 0 {
			s.saveTrack(t.ID, map[string]any{"missing_ticks": 0})
		}
	}
}

// setFirstMedia guarda el cero de la línea de tiempo.
func (s *RecordingService) setFirstMedia(rec *domain.Recording, all []domain.RecordingTrack) {
	var first *time.Time
	for i := range all {
		if all[i].StartedAt == nil {
			continue
		}
		if first == nil || all[i].StartedAt.Before(*first) {
			first = all[i].StartedAt
		}
	}
	if first == nil || (rec.FirstMediaAt != nil && rec.FirstMediaAt.Equal(*first)) {
		return
	}
	if _, err := s.repo.Transition(rec.ID, rec.Status, rec.Status,
		map[string]any{"first_media_at": *first}); err != nil {
		lg.Error("recording: saving the first media instant: " + err.Error())
		return
	}
	rec.FirstMediaAt = first
}

// ─── Consultas ───────────────────────────────────────────────────────────────

func (s *RecordingService) Policy(spaceID string) (*domain.RecordingPolicy, error) {
	if !s.Enabled() {
		return &domain.RecordingPolicy{Enabled: false}, nil
	}
	active, err := s.repo.ActiveInSpace(spaceID)
	if err != nil {
		return nil, err
	}
	out := &domain.RecordingPolicy{Enabled: true}
	if active != nil {
		out.Active = s.decorate(*active, nil)
	}
	return out, nil
}

func (s *RecordingService) List(spaceID string, limit int, before *time.Time) ([]domain.RecordingResponse, error) {
	rows, err := s.repo.ListBySpace(spaceID, limit, before)
	if err != nil {
		return nil, err
	}
	names := s.names(rows)
	out := make([]domain.RecordingResponse, 0, len(rows))
	for _, r := range rows {
		item := *s.decorate(r, nil)
		item.StartedByName = names[r.StartedBy]
		out = append(out, item)
	}
	return out, nil
}

func (s *RecordingService) Get(id string) (*domain.RecordingResponse, error) {
	rec, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	tracks, err := s.repo.Tracks(id)
	if err != nil {
		return nil, err
	}
	out := s.decorate(*rec, tracks)
	out.StartedByName = s.names([]domain.Recording{*rec})[rec.StartedBy]
	return out, nil
}

func (s *RecordingService) FindByID(id string) (*domain.Recording, error) {
	return s.repo.FindByID(id)
}

func (s *RecordingService) decorate(rec domain.Recording, tracks []domain.RecordingTrack) *domain.RecordingResponse {
	return &domain.RecordingResponse{Recording: rec, Tracks: tracks}
}

func (s *RecordingService) names(rows []domain.Recording) map[string]string {
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.StartedBy)
	}
	names, err := s.repo.DisplayNames(ids)
	if err != nil {
		lg.Warn("recording: resolving display names: " + err.Error())
		return map[string]string{}
	}
	return names
}

// ─── La señal de que se está grabando ────────────────────────────────────────

// markRoom pone (o quita) el aviso en el metadata de la sala.
//
// Por metadata y no sólo por SSE: quien **entra después** recibe el metadata al
// conectarse, así que ve el chip REC sin que nadie tenga que repetirle nada.
func (s *RecordingService) markRoom(ctx context.Context, rec *domain.Recording) {
	payload := "{}"
	if rec.Status == domain.RecordingActive {
		b, err := json.Marshal(map[string]any{
			"recording": domain.RecordingSignal{
				ID: rec.ID, By: rec.StartedBy, Since: rec.StartedAt, SpaceID: rec.SpaceID,
			},
		})
		if err != nil {
			lg.Error("recording: serialising the REC signal: " + err.Error())
			return
		}
		payload = string(b)
	}
	if err := s.lk.SetRoomMetadata(ctx, rec.Room, payload); err != nil {
		lg.Warn("recording: marking room " + rec.Room + ": " + err.Error())
	}
}

// publish avisa a la organización por SSE.
func (s *RecordingService) publish(rec *domain.Recording) {
	if s.hub == nil {
		return
	}
	var signal *domain.RecordingSignal
	if rec.Status == domain.RecordingActive {
		signal = &domain.RecordingSignal{
			ID: rec.ID, By: rec.StartedBy, Since: rec.StartedAt, SpaceID: rec.SpaceID,
		}
	}
	s.hub.Publish(events.Event{
		Type:  "call:status",
		OrgID: rec.OrgID,
		Data: map[string]any{
			"spaceId": rec.SpaceID, "recordingId": rec.ID,
			"status": rec.Status, "recording": signal,
		},
	})
}

// ─── Ayudas ──────────────────────────────────────────────────────────────────

// humans cuenta a la gente de verdad: el grabador de LiveKit entra a la sala
// como un participante más, y contarlo haría que una sala en la que sólo queda
// el grabador pareciera ocupada — y la grabación no pararía nunca.
func humans(people []*lksdk.ParticipantInfo) int {
	n := 0
	for _, p := range people {
		if p.Kind == lksdk.ParticipantInfo_STANDARD {
			n++
		}
	}
	return n
}

func (s *RecordingService) saveTrack(id string, fields map[string]any) {
	if err := s.repo.SaveTrack(id, fields); err != nil {
		lg.Error("recording: saving track " + id + ": " + err.Error())
	}
}

// truncate recorta lo que va a una columna de 400. Un error de Egress puede
// traer un volcado entero.
func truncate(s string) string {
	const max = 380
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
