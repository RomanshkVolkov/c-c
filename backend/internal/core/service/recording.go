package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	lksdk "github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Dos respuestas malas seguidas antes de dar una pista por muerta, y no una:
// un tiempo de espera agotado puede ser el SFU con un mal momento, y matar una
// pista por eso tira material que estaba llegando bien.
const missingTicksToFail = 2

// Y el cinturón: una pista que sigue viva cinco minutos después de que la
// grabación acabara no va a revivir. Cinco y no uno porque esto sólo actúa
// cuando la señal buena no está disponible, y equivocarse aquí tira material.
const finalizingGraceS = 5 * time.Minute

var (
	// ErrRecordingsDisabled: esta instalación no graba. No es un fallo.
	ErrRecordingsDisabled = errors.New("recordings are not enabled")
	// ErrRoomEmpty: grabar una sala vacía guardaría un fichero de silencio y
	// dejaría el chip REC encendido para nadie.
	ErrRoomEmpty = errors.New("nobody is in the call")
	// ErrNoMedia: la grabación existe pero todavía no tiene fichero montado.
	ErrNoMedia = errors.New("this recording has no media yet")
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
	// store es el bucket: leer el montaje para servirlo, y borrarlo al borrar
	// la grabación. **Escribir no**: quien escribe las pistas es Egress con su
	// propia credencial, y quien escribe el montaje es el mux con la suya.
	//
	// Interfaz y no el `*mediastore.Store` concreto para poder doblarlo: lo que
	// hay que poder probar sin S3 es que un `Range` sale como 206 con su
	// `Content-Range`, y que la clave del objeto no se filtra por ningún lado.
	store MediaStore
}

// MediaStore es lo que el servicio necesita del bucket, y nada más.
type MediaStore interface {
	Enabled() bool
	GetRange(ctx context.Context, key, rng string) (*mediastore.Object, error)
	Delete(ctx context.Context, keys ...string) error
}

func NewRecordingService(
	repo *repository.RecordingRepository, lk lkclient.Client, hub *events.Hub,
	store MediaStore, prefix string, enabled bool, maxMinutes int,
) *RecordingService {
	if prefix == "" {
		prefix = domain.RecordingPrefixDefault
	}
	if maxMinutes <= 0 {
		maxMinutes = 240
	}
	return &RecordingService{
		repo: repo, lk: lk, hub: hub, store: store, prefix: prefix,
		enabled: enabled, maxMinutes: maxMinutes,
	}
}

// Enabled: las tres condiciones. Si falta una, la app esconde el botón en vez
// de enseñar uno que siempre falla.
func (s *RecordingService) Enabled() bool {
	return s != nil && s.enabled && s.lk != nil && s.store != nil && s.store.Enabled()
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
	people, err := s.lk.Participants(ctx, rec.Room)
	if err != nil {
		// Una sala que ya no existe es una sala vacía: el SFU la tira cuando se
		// va el último, y eso es exactamente lo que queremos detectar. Tratarlo
		// como error dejaría la grabación abierta para siempre.
		lg.Warn("recording: " + rec.Room + " does not answer: " + err.Error())
		people = nil
	}
	if rec.Status == domain.RecordingActive {
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
		s.probeStopped(ctx, rec)
		// El cinturón por si la señal de arriba no llega: una pista que sigue
		// viva mucho después de que la grabación terminara **no va a revivir**,
		// y dejarla así cuelga la grabación en `finalizing` para siempre — el
		// mux no la ve nunca. Pasa cuando el SFU no contesta y no se puede
		// mirar quién sigue en la sala.
		if rec.EndedAt != nil && now.Sub(*rec.EndedAt) > finalizingGraceS {
			for i := range live {
				if domain.TrackTerminal(live[i].Status) {
					continue
				}
				s.saveTrack(live[i].ID, map[string]any{
					"status": domain.TrackFailed, "error": "still running long after the recording ended",
				})
			}
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
func (s *RecordingService) reconcileTrack(t *domain.RecordingTrack,
	known map[string]*lksdk.EgressInfo) {
	info, seen := known[t.EgressID]
	if !seen {
		// Un egress que el SFU ya no conoce: el bus no tiene persistencia, así
		// que si se vació no sabe nada de lo que estaba haciendo. Tres ticks
		// antes de darla por perdida, para no confundirlo con una respuesta
		// incompleta.
		s.missing(t, "egress vanished")
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
		//
		//
		// **Un egress cuyo pod ha muerto se queda aquí para siempre.** Medido
		// contra LiveKit 1.13.5: el registro sigue diciendo `EGRESS_ACTIVE` con
		// `ended_at: 0`, y ninguna de las señales pasivas lo delata —
		// `updated_at` no late ni siquiera cuando el egress está sano (se
		// midió: congelado y envejeciendo mientras grababa), y el participante
		// del egress **no se va de la sala** al morir el pod (se midió:
		// presente los 157 s que duró la prueba). Lo único que lo distingue es
		// preguntárselo, y eso está en `probeStopped`.
		if t.MissingTicks != 0 {
			s.saveTrack(t.ID, map[string]any{"missing_ticks": 0})
		}
	}
}

// probeStopped pregunta si alguien sigue al otro lado, y sólo al cerrar.
//
// Es la única señal que hay. Se midió contra el SFU: `StopEgress` sobre un
// egress cuyo trabajador murió contesta **408 `deadline_exceeded` en 3,4 s** —
// nadie lo posee—, mientras que sobre uno vivo termina el trabajo. Por eso no
// sirve como latido durante la grabación: preguntarlo **es** pararlo.
//
// De ahí sale el reparto honesto de lo que este diseño puede y no puede:
//
//   - Mientras se graba, un pod de Egress que se muere **no se detecta**. Lo
//     que se escribió antes está en S3; lo de después se pierde. Con LiveKit
//     1.13.5 no hay forma de saberlo sin romper la grabación de los vivos.
//   - Al parar, se detecta en ~20 s y la grabación cierra —como `partial` si
//     algo se salvó, `failed` si no— en vez de quedarse colgada en `finalizing`
//     para siempre, que es lo que hacía.
//
// **No vale contar cualquier error**, y eso también se midió. Volver a pedir
// que pare tiene tres respuestas distintas, y sólo una significa lo que se
// busca:
//
//	cerrando (ENDING)    → 200 OK, y no pasa nada por pedirlo dos veces
//	ya terminado         → 412 failed_precondition «cannot be stopped»
//	nadie al otro lado   → 408 deadline_exceeded, en 3,4 s
//
// El 412 es buena noticia —LiveKit sabe quién es y ya acabó— y contarlo como
// muerte tiraría pistas buenas. Por eso se mira el código y no el hecho de
// haber fallado; y por eso tampoco hace falta un periodo de gracia.
func (s *RecordingService) probeStopped(ctx context.Context, rec *domain.Recording) {
	if rec.Status != domain.RecordingFinalizing || rec.EndedAt == nil {
		return
	}
	live, err := s.repo.LiveTracks(rec.ID)
	if err != nil {
		lg.Error("recording: listing live tracks to probe: " + err.Error())
		return
	}
	for i := range live {
		t := &live[i]
		if t.EgressID == "" {
			continue
		}
		_, err := s.lk.StopEgress(ctx, rec.Room, t.EgressID)
		if err != nil && nobodyAnswered(err) {
			n := t.ProbeFailures + 1
			fields := map[string]any{"probe_failures": n}
			if n >= missingTicksToFail {
				fields["status"] = domain.TrackFailed
				fields["error"] = truncate("nobody answers for this egress: " + err.Error())
			}
			s.saveTrack(t.ID, fields)
			continue
		}
		if t.ProbeFailures != 0 {
			s.saveTrack(t.ID, map[string]any{"probe_failures": 0})
		}
	}
}

// nobodyAnswered: el error significa «no hay nadie al otro lado».
//
// Por el código de Twirp y no por el texto: el texto lleva la versión y el
// idioma del servidor, y una comparación contra él se rompe en silencio el día
// que cambien la frase. Cualquier otro error —incluido el 412 de «ya está
// terminado»— dice que LiveKit sí sabe de ese egress, que es lo contrario de
// lo que se busca.
func nobodyAnswered(err error) bool {
	var te twirp.Error
	return errors.As(err, &te) && te.Code() == twirp.DeadlineExceeded
}

// missing cuenta una ausencia y mata la pista a la tercera.
func (s *RecordingService) missing(t *domain.RecordingTrack, reason string) {
	n := t.MissingTicks + 1
	fields := map[string]any{"missing_ticks": n}
	if n >= missingTicksToFail {
		fields["status"] = domain.TrackFailed
		fields["error"] = reason
	}
	s.saveTrack(t.ID, fields)
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

// ─── El protocolo del mux ────────────────────────────────────────────────────

// El mux es un proceso aparte que baja las pistas, las monta con ffmpeg y sube
// el resultado. Habla con esto por un puerto interno, y el reparto de trabajo
// es una columna de la base —no una cola— por una razón concreta: la verdad de
// «qué hay que montar» ya vive en Postgres, y ponerla también en una cola
// obligaría a escribir el mismo `UPDATE` condicional en dos sitios.
//
// El mux **no tiene ninguna credencial de cac**: una llave y un puerto. Y no
// puede leer el bucket entero — su usuario de IAM sólo alcanza `recordings/`.

// muxLease: cuánto se reserva una grabación mientras se monta.
//
// Quince minutos porque montar diez minutos de llamada tarda menos de uno
// —medido: 36× tiempo real— y lo que esto cubre no es el caso normal sino el
// mux que se muere a mitad: hasta que el plazo vence, nadie más la coge.
const muxLease = 15 * time.Minute

// Prefix: dónde van los objetos de esta instalación. Lo necesita el mux para
// subir el montaje sin adivinar la clave.
func (s *RecordingService) Prefix() string { return s.prefix }

// PendingMux: lo que está listo para montar.
func (s *RecordingService) PendingMux(now time.Time, limit int) ([]domain.RecordingResponse, error) {
	rows, err := s.repo.PendingMux(now, limit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RecordingResponse, 0, len(rows))
	for _, rec := range rows {
		tracks, err := s.repo.Tracks(rec.ID)
		if err != nil {
			return nil, err
		}
		// Sólo las que tienen fichero. Una pista fallida no se monta, pero sí
		// cuenta: es lo que convierte el resultado en `partial` en vez de
		// `ready`, y quien lo mire tiene derecho a saber que falta alguien.
		usable := make([]domain.RecordingTrack, 0, len(tracks))
		for _, t := range tracks {
			if t.Status == domain.TrackComplete && t.ObjectKey != "" {
				usable = append(usable, t)
			}
		}
		out = append(out, domain.RecordingResponse{
			Recording: rec, Tracks: usable, FailedTracks: len(tracks) - len(usable),
		})
	}
	return out, nil
}

// ClaimMux reserva una grabación para un mux. `false` es «otro llegó antes».
func (s *RecordingService) ClaimMux(id string, now time.Time) (bool, error) {
	rec, err := s.repo.FindByID(id)
	if err != nil {
		return false, err
	}
	seen := rec.MuxLeaseUntil
	if seen != nil && seen.After(now) {
		return false, nil // reservada y todavía en plazo
	}
	return s.repo.LeaseMux(id, seen, now.Add(muxLease))
}

// MuxReady cierra la grabación con su fichero montado.
//
// `partial` y no `ready` cuando alguna pista se perdió: hay vídeo, pero no
// está toda la gente. Enseñarlo como completo sería mentir por omisión.
func (s *RecordingService) MuxReady(id, key, contentType string, bytes, durationMs int64, hasScreen bool) error {
	rec, err := s.repo.FindByID(id)
	if err != nil {
		return err
	}
	tracks, err := s.repo.Tracks(id)
	if err != nil {
		return err
	}
	estado := domain.RecordingReady
	for _, t := range tracks {
		if t.Status == domain.TrackFailed {
			estado = domain.RecordingPartial
			break
		}
	}
	ok, err := s.repo.Transition(id, domain.RecordingFinalizing, estado, map[string]any{
		"final_key": key, "final_content_type": contentType,
		"final_bytes": bytes, "duration_ms": durationMs, "has_screen": hasScreen,
		"mux_lease_until": nil,
	})
	if err != nil || !ok {
		return err
	}
	rec.Status = estado
	s.publish(rec)
	return nil
}

// MuxFailed: el montaje no salió. **Las pistas se conservan**: son el material
// para reintentarlo, y son la transcripción de mañana.
func (s *RecordingService) MuxFailed(id, reason string) error {
	rec, err := s.repo.FindByID(id)
	if err != nil {
		return err
	}
	ok, err := s.repo.Transition(id, domain.RecordingFinalizing, domain.RecordingFailed,
		map[string]any{"error": truncate(reason), "mux_lease_until": nil})
	if err != nil || !ok {
		return err
	}
	rec.Status = domain.RecordingFailed
	s.publish(rec)
	return nil
}

// ─── Ver y borrar ────────────────────────────────────────────────────────────

// Media abre el fichero montado, entero o por trozos.
//
// Pasa por cac y no por una URL del bucket: una URL firmada que se escapa de
// una pantalla sigue valiendo hasta que caduca, y una grabación de una reunión
// no es algo que uno quiera repartir por accidente.
func (s *RecordingService) Media(ctx context.Context, rec *domain.Recording, rng string) (*mediastore.Object, error) {
	if rec.FinalKey == "" {
		return nil, ErrNoMedia
	}
	return s.store.GetRange(ctx, rec.FinalKey, rng)
}

// Delete borra la grabación: primero los objetos, después la fila.
//
// En ese orden a propósito. Si S3 falla, la fila se queda y se puede volver a
// intentar; al revés quedarían ficheros en el bucket sin nadie que sepa que
// existen ni cómo se llamaban.
func (s *RecordingService) Delete(ctx context.Context, rec *domain.Recording) error {
	tracks, err := s.repo.Tracks(rec.ID)
	if err != nil {
		return err
	}
	keys := make([]string, 0, len(tracks)+1)
	if rec.FinalKey != "" {
		keys = append(keys, rec.FinalKey)
	}
	for _, t := range tracks {
		if t.ObjectKey != "" {
			keys = append(keys, t.ObjectKey)
		}
	}
	if len(keys) > 0 {
		if err := s.store.Delete(ctx, keys...); err != nil {
			return err
		}
	}
	return s.repo.DeleteWithTracks(rec.ID)
}
