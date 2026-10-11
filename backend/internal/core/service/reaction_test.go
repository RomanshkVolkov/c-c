package service

import (
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Las reacciones (domain/reaction.go): un emoji sobre un mensaje.
//
// Lo serio aquí no es contar, es **de quién es el mensaje**: la ruta autoriza
// un canal o una conversación, y el id del mensaje lo pone quien llama. Si el
// servicio no comprobara que el mensaje es de ahí, reaccionar sería una forma
// de tocar —y de saber que existe— un mensaje de un sitio que no puedes leer.
//
// Mutantes: no comprobar el canal del mensaje; no comprobar la conversación;
// aceptar cualquier emoji; `mine` siempre a falso o a verdadero; contar a
// quien quita; mezclar los destinos (un directo contado en el canal).

func reactionChat(t *testing.T) (*ChatService, *gorm.DB, func()) {
	t.Helper()
	db, cleanup := chatDB(t)
	if err := db.AutoMigrate(&domain.ChatReaction{}); err != nil {
		t.Fatal(err)
	}
	for _, u := range []struct{ id, user, name string }{
		{"u-ana", "ana", "Ana Pérez"}, {"u-bea", "bea", ""},
	} {
		user := &domain.User{Username: u.user, Name: u.name}
		user.ID = u.id
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	return NewChatService(repository.NewChatRepository(db), nil), db, cleanup
}

func reactionsOf(t *testing.T, svc *ChatService, spaceID, viewer string) map[string][]domain.ReactionSummary {
	t.Helper()
	msgs, err := svc.List(spaceID, "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.FillReactions(msgs, viewer); err != nil {
		t.Fatal(err)
	}
	out := map[string][]domain.ReactionSummary{}
	for _, m := range msgs {
		out[m.ID] = m.Reactions
	}
	return out
}

func TestUnaReaccionSeCuentaUnaVezYSeQuita(t *testing.T) {
	svc, _, cleanup := reactionChat(t)
	defer cleanup()
	m, err := svc.Post("sp-1", "org-1", "u-ana", "¿subimos hoy?")
	if err != nil {
		t.Fatal(err)
	}

	// Dos veces el mismo es una: el doble clic no cuenta doble.
	for range 2 {
		if err := svc.React("sp-1", m.ID, "u-bea", "👍", true); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.React("sp-1", m.ID, "u-ana", "👍", true); err != nil {
		t.Fatal(err)
	}
	if err := svc.React("sp-1", m.ID, "u-ana", "🎉", true); err != nil {
		t.Fatal(err)
	}

	// Para Bea: dos 👍 con el suyo marcado, y la 🎉 que no es suya. Los nombres
	// son los que se enseñan (`nombreVisible`), en el orden en que reaccionaron.
	r := reactionsOf(t, svc, "sp-1", "u-bea")[m.ID]
	if len(r) != 2 || r[0].Emoji != "👍" || r[1].Emoji != "🎉" {
		t.Fatalf("emojis en el orden del primero: %+v", r)
	}
	if r[0].Count != 2 || !r[0].Mine || r[1].Count != 1 || r[1].Mine {
		t.Fatalf("cuentas o «mío» mal para Bea: %+v", r)
	}
	if len(r[0].Names) != 2 || r[0].Names[0] != "bea" || r[0].Names[1] != "Ana Pérez" {
		t.Fatalf("quiénes, por su nombre y en orden: %v", r[0].Names)
	}

	// Quitar el suyo lo quita a ella, no a Ana.
	if err := svc.React("sp-1", m.ID, "u-bea", "👍", false); err != nil {
		t.Fatal(err)
	}
	r = reactionsOf(t, svc, "sp-1", "u-bea")[m.ID]
	if r[0].Count != 1 || r[0].Mine {
		t.Fatalf("tras quitar el suyo: %+v", r)
	}
	// Y un mensaje sin reacciones trae la lista vacía, no nula: la app la recorre.
	m2, _ := svc.Post("sp-1", "org-1", "u-ana", "otro")
	if got := reactionsOf(t, svc, "sp-1", "u-ana")[m2.ID]; got == nil || len(got) != 0 {
		t.Fatalf("sin reacciones debe ser [], es %#v", got)
	}
}

func TestNoSeReaccionaAUnMensajeDeOtroCanal(t *testing.T) {
	svc, db, cleanup := reactionChat(t)
	defer cleanup()
	ajeno, _ := svc.Post("sp-privado", "org-1", "u-ana", "lo que no ves")

	// La ruta autorizó sp-1; el mensaje es de sp-privado.
	err := svc.React("sp-1", ajeno.ID, "u-bea", "👀", true)
	if !errors.Is(err, repository.ErrMessageNotFound) {
		t.Fatalf("debía ser «no encontrado», fue %v", err)
	}
	var n int64
	db.Model(&domain.ChatReaction{}).Count(&n)
	if n != 0 {
		t.Fatalf("se guardó una reacción a un mensaje ajeno")
	}
}

func TestSoloSeAceptanLosEmojisDelJuego(t *testing.T) {
	svc, _, cleanup := reactionChat(t)
	defer cleanup()
	m, _ := svc.Post("sp-1", "org-1", "u-ana", "hola")
	for _, e := range []string{"<img src=x>", "🍆", "", "👍👍"} {
		if err := svc.React("sp-1", m.ID, "u-bea", e, true); !errors.Is(err, ErrBadReaction) {
			t.Errorf("%q debía rechazarse, fue %v", e, err)
		}
	}
	for _, e := range domain.ReactionEmojis {
		if err := svc.React("sp-1", m.ID, "u-bea", e, true); err != nil {
			t.Errorf("%q es del juego y falló: %v", e, err)
		}
	}
}

func TestEnLosDirectosSoloReaccionanLosDos(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.ChatReaction{}); err != nil {
		t.Fatal(err)
	}
	svc := NewDMService(repository.NewDMRepository(db), nil)
	anaBea, err := svc.OpenWith("org-1", "u-ana", "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	anaCarla, _ := svc.OpenWith("org-1", "u-ana", "u-carla")
	m, _ := svc.Post(anaBea.ID, "u-ana", "entre nosotras")
	otro, _ := svc.Post(anaCarla.ID, "u-ana", "con Carla")

	if err := svc.React(anaBea.ID, m.ID, "u-bea", "❤️", true); err != nil {
		t.Fatal(err)
	}
	// Carla no está en esa conversación.
	if err := svc.React(anaBea.ID, m.ID, "u-carla", "❤️", true); !errors.Is(err, repository.ErrConversationNotFound) {
		t.Fatalf("Carla reaccionó en una conversación ajena: %v", err)
	}
	// Bea no puede reaccionar a un mensaje de Ana y Carla pasándolo por la suya.
	if err := svc.React(anaBea.ID, otro.ID, "u-bea", "❤️", true); !errors.Is(err, repository.ErrDMMessageNotFound) {
		t.Fatalf("reaccionó a un mensaje de otra conversación: %v", err)
	}

	list, err := svc.List(anaBea.ID, "u-ana", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || len(list[0].Reactions) != 1 || list[0].Reactions[0].Count != 1 || list[0].Reactions[0].Mine {
		t.Fatalf("Ana ve el ❤️ de Bea, no marcado como suyo: %+v", list)
	}
}

// Una tabla para los tres chats: lo que separa a cada uno es `target`. Un id
// repetido en dos chats (no pasa con uuid, pero la consulta no debe fiarse de
// ello) no mezcla sus reacciones.
func TestLasReaccionesDeUnChatNoSeCuentanEnOtro(t *testing.T) {
	_, db, cleanup := reactionChat(t)
	defer cleanup()
	repo := repository.NewReactionRepository(db)
	if err := repo.Set(domain.ReactionDM, "m-1", "u-ana", "🔥", true); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Summaries(domain.ReactionChannel, []string{"m-1"}, "u-ana")
	if err != nil {
		t.Fatal(err)
	}
	if len(got["m-1"]) != 0 {
		t.Fatalf("una reacción de un directo salió en el canal: %+v", got)
	}
}
