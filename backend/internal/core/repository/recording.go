package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var (
	ErrRecordingNotFound = errors.New("recording not found")
	// ErrAlreadyRecording: ya hay una grabación viva en ese espacio. No es un
	// fallo del servidor, es la respuesta correcta a pulsar dos veces.
	ErrAlreadyRecording = errors.New("this space is already being recorded")
)

type RecordingRepository struct{ db *gorm.DB }

func NewRecordingRepository(db *gorm.DB) *RecordingRepository {
	return &RecordingRepository{db: db}
}

// Create inserta la grabación. El índice único parcial decide si cabe.
//
// Se distingue el choque del índice de cualquier otro error: con dos réplicas y
// dos personas pulsando a la vez, «ya se está grabando» es un 409 honesto y no
// un 500.
func (r *RecordingRepository) Create(rec *domain.Recording) error {
	err := r.db.Create(rec).Error
	if err != nil && isUniqueViolation(err) {
		return ErrAlreadyRecording
	}
	return err
}

func (r *RecordingRepository) FindByID(id string) (*domain.Recording, error) {
	var rec domain.Recording
	if err := r.db.First(&rec, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRecordingNotFound
		}
		return nil, err
	}
	return &rec, nil
}

// ActiveInSpace: la grabación viva de un espacio, si la hay.
//
// Devuelve `nil, nil` cuando no hay ninguna: «no se está grabando» no es un
// error, es la respuesta que la app espera casi siempre.
func (r *RecordingRepository) ActiveInSpace(spaceID string) (*domain.Recording, error) {
	var rec domain.Recording
	err := r.db.Where("space_id = ? AND status = ?", spaceID, domain.RecordingActive).
		First(&rec).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

// Unfinished: lo que el reloj tiene que mirar en cada tick.
//
// Son las dos que todavía se mueven solas: las que están grabando y las que ya
// pararon pero siguen esperando a que sus egress cierren. Las terminales no
// entran — de ahí no sale nada sin que alguien lo pida.
func (r *RecordingRepository) Unfinished() ([]domain.Recording, error) {
	var out []domain.Recording
	err := r.db.Where("status IN ?", []domain.RecordingStatus{
		domain.RecordingActive, domain.RecordingFinalizing,
	}).Order("started_at ASC").Find(&out).Error
	return out, err
}

// ListBySpace: el panel de grabaciones, la más nueva primero.
func (r *RecordingRepository) ListBySpace(spaceID string, limit int, before *time.Time) ([]domain.Recording, error) {
	q := r.db.Where("space_id = ?", spaceID)
	if before != nil {
		q = q.Where("started_at < ?", *before)
	}
	var out []domain.Recording
	err := q.Order("started_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// Transition mueve el estado **sólo si sigue siendo el que se vio**.
//
// Es el mismo patrón que `MeetingRepository.Reservar`, y por la misma razón: con
// dos réplicas, leer-decidir-escribir tiene una ventana en la que las dos leen
// lo mismo. Aquí se traduciría en dos `StopEgress` de la misma pista, o en una
// grabación que pasa a `ready` mientras otra réplica la pone en `failed`.
//
// `false` sin error significa «otro llegó antes», que casi siempre es la
// respuesta correcta y no algo que registrar.
func (r *RecordingRepository) Transition(id string, from, to domain.RecordingStatus, fields map[string]any) (bool, error) {
	if !domain.CanTransitionRecording(from, to) {
		return false, nil
	}
	if fields == nil {
		fields = map[string]any{}
	}
	fields["status"] = to
	res := r.db.Model(&domain.Recording{}).
		Where("id = ? AND status = ?", id, from).
		Updates(fields)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// ClaimTick: una réplica por grabación y por tick.
//
// El testigo es `ticked_at`: quien consigue cambiarlo se queda el tick. Sin la
// condición, las dos réplicas descubrirían las mismas pistas a la vez y las dos
// llamarían a `StartTrackEgress` — el `ClaimTrack` de abajo pararía el daño,
// pero después de haber arrancado dos egress.
func (r *RecordingRepository) ClaimTick(id string, seen, now time.Time) (bool, error) {
	res := r.db.Model(&domain.Recording{}).
		Where("id = ? AND ticked_at = ?", id, seen).
		Update("ticked_at", now)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// SetEmptyTicks guarda la cuenta de ticks seguidos sin nadie dentro.
func (r *RecordingRepository) SetEmptyTicks(id string, n int) error {
	return r.db.Model(&domain.Recording{}).Where("id = ?", id).
		Update("empty_ticks", n).Error
}

// ─── Pistas ──────────────────────────────────────────────────────────────────

// ClaimTrack inserta la pista, o no hace nada si ya estaba.
//
// **Quien inserta es quien lanza el egress.** `ON CONFLICT DO NOTHING` sobre
// `track_sid` convierte «¿ya la estamos grabando?» en una pregunta que contesta
// la base de datos y no una lectura previa que otra réplica puede invalidar
// entre la lectura y la escritura.
func (r *RecordingRepository) ClaimTrack(t *domain.RecordingTrack) (bool, error) {
	res := r.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "track_sid"}}, DoNothing: true}).
		Create(t)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

func (r *RecordingRepository) Tracks(recordingID string) ([]domain.RecordingTrack, error) {
	var out []domain.RecordingTrack
	err := r.db.Where("recording_id = ?", recordingID).
		Order("started_at ASC, created_at ASC").Find(&out).Error
	return out, err
}

// LiveTracks: las que todavía pueden cambiar solas.
func (r *RecordingRepository) LiveTracks(recordingID string) ([]domain.RecordingTrack, error) {
	var out []domain.RecordingTrack
	err := r.db.Where("recording_id = ? AND status IN ?", recordingID,
		[]string{domain.TrackStarting, domain.TrackActive}).Find(&out).Error
	return out, err
}

func (r *RecordingRepository) SaveTrack(id string, fields map[string]any) error {
	return r.db.Model(&domain.RecordingTrack{}).Where("id = ?", id).Updates(fields).Error
}

// DeleteWithTracks borra la grabación y sus pistas. Los objetos de S3 los borra
// el servicio **antes**: si el bucket falla, la fila se queda y se puede
// reintentar; al revés quedarían ficheros sin nadie que sepa que existen.
func (r *RecordingRepository) DeleteWithTracks(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("recording_id = ?", id).Delete(&domain.RecordingTrack{}).Error; err != nil {
			return err
		}
		return tx.Delete(&domain.Recording{}, "id = ?", id).Error
	})
}

// ─── La cola del mux ─────────────────────────────────────────────────────────

// PendingMux: las que ya tienen todos sus ficheros cerrados y nadie está
// montando.
//
// El `lease` es una columna y no una cola aparte: la verdad de «qué hay que
// montar» ya vive aquí, y repartirla en dos sitios obligaría a escribir el
// mismo `UPDATE` condicional dos veces.
func (r *RecordingRepository) PendingMux(now time.Time, limit int) ([]domain.Recording, error) {
	var out []domain.Recording
	err := r.db.Where("status = ? AND egress_done_at IS NOT NULL", domain.RecordingFinalizing).
		Where("mux_lease_until IS NULL OR mux_lease_until < ?", now).
		Order("egress_done_at ASC").Limit(limit).Find(&out).Error
	return out, err
}

// LeaseMux se queda una grabación durante un rato. Condicional sobre el lease
// anterior: dos muxes no montan la misma.
func (r *RecordingRepository) LeaseMux(id string, seen *time.Time, until time.Time) (bool, error) {
	q := r.db.Model(&domain.Recording{}).Where("id = ? AND status = ?", id, domain.RecordingFinalizing)
	if seen == nil {
		q = q.Where("mux_lease_until IS NULL")
	} else {
		q = q.Where("mux_lease_until = ?", *seen)
	}
	res := q.Update("mux_lease_until", until)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// DisplayNames resuelve cómo se llama la gente que empezó estas grabaciones.
//
// Por `nombreVisible` y no a mano: un identificador de acceso no es cómo se
// llama a una persona, y hay un guardián que lo vigila
// (`TestNadieResuelveElNombreASuAire`).
func (r *RecordingRepository) DisplayNames(ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		ID   string
		Name string
	}
	err := r.db.Table("users").
		Select("id, "+nombreVisible+" as name").
		Where("id IN ?", ids).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.ID] = row.Name
	}
	return out, nil
}
