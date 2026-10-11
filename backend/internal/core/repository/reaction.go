package repository

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// ReactionRepository guarda las reacciones de los tres chats (ver
// domain/reaction.go). No comprueba quién puede reaccionar: eso es del servicio
// de cada chat, que es quien sabe de quién es el mensaje.
type ReactionRepository struct{ db *gorm.DB }

func NewReactionRepository(db *gorm.DB) *ReactionRepository { return &ReactionRepository{db: db} }

// Set pone o quita una reacción. Poner una que ya está, o quitar una que no,
// no es un error: es el estado que se pedía.
func (r *ReactionRepository) Set(target domain.ReactionTarget, messageID, actorID, emoji string, on bool) error {
	if !on {
		return r.db.Where("target = ? AND message_id = ? AND actor_id = ? AND emoji = ?",
			target, messageID, actorID, emoji).Delete(&domain.ChatReaction{}).Error
	}
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&domain.ChatReaction{
		Target: target, MessageID: messageID, ActorID: actorID, Emoji: emoji, CreatedAt: time.Now(),
	}).Error
}

// Summaries cuenta las reacciones de una página de mensajes, en una consulta.
//
// Los emojis de cada mensaje salen en el orden en que se puso el primero de
// cada uno, y los nombres en el orden en que reaccionó cada cual: así una
// reacción nueva no reordena las que ya estaban.
func (r *ReactionRepository) Summaries(
	target domain.ReactionTarget, messageIDs []string, viewerID string,
) (map[string][]domain.ReactionSummary, error) {
	out := map[string][]domain.ReactionSummary{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	var filas []struct {
		MessageID string
		ActorID   string
		Emoji     string
		Name      string
	}
	err := r.db.Table("chat_reactions r").
		Select(`r.message_id, r.actor_id, r.emoji,
			COALESCE((SELECT `+nombreVisible+` FROM users WHERE id = r.actor_id), '') AS name`).
		Where("r.target = ? AND r.message_id IN ?", target, messageIDs).
		Order("r.created_at, r.actor_id").
		Scan(&filas).Error
	if err != nil {
		return nil, err
	}
	for _, f := range filas {
		lista := out[f.MessageID]
		i := -1
		for j := range lista {
			if lista[j].Emoji == f.Emoji {
				i = j
				break
			}
		}
		if i < 0 {
			lista = append(lista, domain.ReactionSummary{Emoji: f.Emoji, Names: []string{}})
			i = len(lista) - 1
		}
		lista[i].Count++
		lista[i].Names = append(lista[i].Names, f.Name)
		if f.ActorID == viewerID {
			lista[i].Mine = true
		}
		out[f.MessageID] = lista
	}
	return out, nil
}
