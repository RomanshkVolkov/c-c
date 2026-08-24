package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var ErrMeetingNotFound = errors.New("meeting not found")

type MeetingRepository struct{ db *gorm.DB }

func NewMeetingRepository(db *gorm.DB) *MeetingRepository {
	return &MeetingRepository{db: db}
}

func (r *MeetingRepository) Create(m *domain.MeetingReminder) error {
	return r.db.Create(m).Error
}

func (r *MeetingRepository) FindByID(id string) (*domain.MeetingReminder, error) {
	var m domain.MeetingReminder
	if err := r.db.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrMeetingNotFound
		}
		return nil, err
	}
	return &m, nil
}

// ListByOrg: la agenda de una organización, la próxima primero.
func (r *MeetingRepository) ListByOrg(orgID string) ([]domain.MeetingReminder, error) {
	var out []domain.MeetingReminder
	err := r.db.Where("org_id = ?", orgID).Order("next_fire_at ASC").Find(&out).Error
	return out, err
}

// Save guarda los campos que el servicio ya decidió cambiar.
//
// `Updates` con mapa y no con struct: con struct, GORM se salta los campos en
// el cero de su tipo, así que despausar una reunión —`Paused: false`— no
// escribiría nada y el cambio se perdería en silencio.
func (r *MeetingRepository) Save(id string, campos map[string]any) error {
	return r.db.Model(&domain.MeetingReminder{}).Where("id = ?", id).Updates(campos).Error
}

func (r *MeetingRepository) Delete(id string) error {
	if err := r.db.Where("meeting_id = ?", id).Delete(&domain.MeetingExclusion{}).Error; err != nil {
		return err
	}
	return r.db.Delete(&domain.MeetingReminder{}, "id = ?", id).Error
}

// ─── Destinatarios: se guarda a quién NO le llega ────────────────────────────

func (r *MeetingRepository) Excluded(meetingID string) ([]string, error) {
	var filas []domain.MeetingExclusion
	if err := r.db.Where("meeting_id = ?", meetingID).Find(&filas).Error; err != nil {
		return nil, err
	}
	out := make([]string, len(filas))
	for i, f := range filas {
		out[i] = f.UserID
	}
	return out, nil
}

// SetExcluded reemplaza la lista de excluidos de una reunión, de una vez.
//
// En una transacción porque el paso intermedio —borrado todo, sin insertar aún—
// es un estado en el que la reunión le llegaría a gente que pidió no recibirla.
// Dura milisegundos, pero el disparador corre cada treinta segundos en dos
// réplicas y no hay ninguna razón para dejar esa rendija abierta.
func (r *MeetingRepository) SetExcluded(meetingID string, userIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("meeting_id = ?", meetingID).Delete(&domain.MeetingExclusion{}).Error; err != nil {
			return err
		}
		if len(userIDs) == 0 {
			return nil
		}
		filas := make([]domain.MeetingExclusion, 0, len(userIDs))
		vistos := map[string]bool{}
		for _, uid := range userIDs {
			if uid == "" || vistos[uid] {
				continue
			}
			vistos[uid] = true
			filas = append(filas, domain.MeetingExclusion{MeetingID: meetingID, UserID: uid})
		}
		if len(filas) == 0 {
			return nil
		}
		return tx.Create(&filas).Error
	})
}

// ─── El disparo ─────────────────────────────────────────────────────────────

// Due son las reuniones a las que ya les tocaba, activas.
func (r *MeetingRepository) Due(now time.Time) ([]domain.MeetingReminder, error) {
	var out []domain.MeetingReminder
	err := r.db.Where("paused = ? AND next_fire_at <= ?", false, now).Find(&out).Error
	return out, err
}

// Reservar se queda con el turno de esta ocurrencia, o dice que no.
//
// Es la pieza que impide el timbre doble. El backend corre con **dos réplicas**
// y las dos miran el reloj: sin esto, las dos verían la misma reunión vencida y
// las dos la anunciarían. Comprobar antes en Go no vale — entre la comprobación
// y la escritura cabe la otra réplica.
//
// El truco es que el propio `next_fire_at` hace de testigo: el UPDATE sólo casa
// si nadie lo ha movido todavía, así que **una sola** réplica ve `RowsAffected`
// igual a 1 y es la que timbra. La otra recibe 0 y se calla.
//
// `visto` tiene que ser el valor leído tal cual, sin redondear: Postgres guarda
// microsegundos y truncarlos haría que el WHERE no case nunca — y entonces no
// timbraría ninguna, que es peor que timbrar dos veces.
func (r *MeetingRepository) Reservar(id string, visto, proxima, ahora time.Time) (bool, error) {
	res := r.db.Model(&domain.MeetingReminder{}).
		Where("id = ? AND next_fire_at = ?", id, visto).
		Updates(map[string]any{"next_fire_at": proxima, "last_fired_at": ahora})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// Reprogramar mueve la próxima ocurrencia sin timbrar: es lo que hace el
// disparador con una reunión que venció hace horas —un pod caído— y con la que
// no hay nada que anunciar, sólo que ponerla en hora.
func (r *MeetingRepository) Reprogramar(id string, visto, proxima time.Time) (bool, error) {
	res := r.db.Model(&domain.MeetingReminder{}).
		Where("id = ? AND next_fire_at = ?", id, visto).
		Updates(map[string]any{"next_fire_at": proxima})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}
