package service

import (
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Responder a un mensaje, en un canal y en un directo. Ver domain/reply.go.
//
// Mutantes: copiar la cita al escribir en vez de leerla (la edición no se ve);
// no mirar si lo citado se retiró; quitar la guarda del canal o de la
// conversación; no avisar a quien le contestan, o avisarle dos veces.

// ana, bea y caro: las de comment_notify_test.go, que son las de la fixture.

// replyIn: la cita de un mensaje tal como la lee el hilo.
func replyIn(t *testing.T, svc *ChatService, spaceID, id string) *domain.MessageQuote {
	t.Helper()
	msgs, err := svc.List(spaceID, "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.ID == id {
			return m.ReplyTo
		}
	}
	t.Fatalf("el mensaje %s no está en el hilo", id)
	return nil
}

// La cita se lee al pintar, no se copia al escribir: si lo citado se edita, la
// cita dice lo nuevo; si se retira, dice que ya no está, sin enseñarlo.
func TestAReplyQuotesWhatTheMessageSaysNow(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)

	orig, err := svc.Post("esp-1", "org-1", ana, "¿quién revisa el PR?")
	if err != nil {
		t.Fatal(err)
	}
	reply, err := svc.Reply("esp-1", "org-1", bea, "yo", orig.ID)
	if err != nil {
		t.Fatal(err)
	}
	q := replyIn(t, svc, "esp-1", reply.ID)
	if q == nil || q.ID != orig.ID || q.AuthorName != "ana" || q.Body != "¿quién revisa el PR?" || q.Gone {
		t.Fatalf("la respuesta tiene que citar lo que contesta; %+v", q)
	}
	if replyIn(t, svc, "esp-1", orig.ID) != nil {
		t.Error("un mensaje que no contesta a nada no lleva cita")
	}

	if err := svc.Edit(orig.ID, ana, false, "¿quién revisa el PR #12?"); err != nil {
		t.Fatal(err)
	}
	if q := replyIn(t, svc, "esp-1", reply.ID); q.Body != "¿quién revisa el PR #12?" {
		t.Errorf("la cita dice lo que ponía antes de editarlo: %q", q.Body)
	}

	if err := svc.Withdraw(orig.ID, ana, false); err != nil {
		t.Fatal(err)
	}
	q = replyIn(t, svc, "esp-1", reply.ID)
	if q == nil || !q.Gone || q.Body != "" || q.AuthorName != "" {
		t.Errorf("retirado, la cita dice que ya no está y no enseña nada; %+v", q)
	}
}

// Lo que se contesta tiene que ser de este canal: la cita se lee con un join
// que no lo mira, así que sin la guarda un id de otra org enseñaría aquí su
// texto.
func TestAReplyCannotQuoteAnotherChannel(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)

	ajeno, err := svc.Post("esp-otra", "org-2", "44444444-4444-4444-8444-444444444444", "lo de otra org")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Reply("esp-1", "org-1", ana, "a ver", ajeno.ID); err != ErrReplyElsewhere {
		t.Errorf("contestar a un mensaje de otro canal → %v, want ErrReplyElsewhere", err)
	}
	gone, _ := svc.Post("esp-1", "org-1", bea, "me retiro")
	if err := svc.Withdraw(gone.ID, bea, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Reply("esp-1", "org-1", ana, "a ver", gone.ID); err != ErrReplyElsewhere {
		t.Errorf("contestar a uno retirado → %v, want ErrReplyElsewhere", err)
	}
}

// A quien le contestan se le avisa como a alguien nombrado, con su título, y
// sólo una vez; a uno mismo, nunca.
func TestWhoIsRepliedToIsTold(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	svc := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)

	orig, _ := svc.Post("esp-1", "org-1", ana, "¿lo subo?")
	espia.avisos = nil
	if _, err := svc.Reply("esp-1", "org-1", bea, "sí", orig.ID); err != nil {
		t.Fatal(err)
	}
	var replied []string
	for _, a := range espia.avisos {
		if a.kind == "chat:mention" && a.titulo == "notify.chat.replied" {
			replied = append(replied, a.userID)
		}
	}
	if len(replied) != 1 || replied[0] != ana {
		t.Errorf("a ana le contestaron: tiene que llegarle a ella y una vez; %v", replied)
	}
	for _, uid := range espia.paraQuien("chat:message") {
		if uid == ana {
			t.Error("y no además el aviso corriente: es la misma línea contada dos veces")
		}
	}

	espia.avisos = nil
	if _, err := svc.Reply("esp-1", "org-1", ana, "me contesto", orig.ID); err != nil {
		t.Fatal(err)
	}
	if m := espia.paraQuien("chat:mention"); len(m) != 0 {
		t.Errorf("contestarse a uno mismo no avisa a nadie; %v", m)
	}
}

// En un directo, lo mismo: la cita, y la guarda de la conversación.
func TestADMReplyStaysInItsConversation(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	svc := NewDMService(repo, nil)

	c, _ := repo.OpenWith("org-1", "u-ana", "u-bea")
	otra, _ := repo.OpenWith("org-1", "u-ana", "u-carla")
	orig, err := svc.Post(c.ID, "u-ana", "¿vienes?")
	if err != nil {
		t.Fatal(err)
	}
	reply, err := svc.Reply(c.ID, "u-bea", "voy", orig.ID)
	if err != nil {
		t.Fatal(err)
	}
	// El repo y no el servicio: el servicio suma las reacciones, y esta base
	// no tiene su tabla. La cita la pone la consulta.
	msgs, err := repo.List(c.ID, time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	var q *domain.MessageQuote
	for _, m := range msgs {
		if m.ID == reply.ID {
			q = m.ReplyTo
		}
	}
	if q == nil || q.ID != orig.ID || q.Body != "¿vienes?" {
		t.Errorf("la respuesta tiene que citar lo que contesta; %+v", q)
	}

	if _, err := svc.Reply(otra.ID, "u-ana", "a ver", orig.ID); err != ErrReplyElsewhere {
		t.Errorf("citar un mensaje de otra conversación → %v, want ErrReplyElsewhere", err)
	}
}

// Una cita larga viaja recortada y se dice que lo está.
func TestALongQuoteIsClipped(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)

	orig, _ := svc.Post("esp-1", "org-1", ana, strings.Repeat("ñ", domain.QuoteLen+50))
	reply, _ := svc.Reply("esp-1", "org-1", bea, "ok", orig.ID)
	q := replyIn(t, svc, "esp-1", reply.ID)
	if want := strings.Repeat("ñ", domain.QuoteLen) + "…"; q.Body != want {
		t.Errorf("recortada a %d runas y con «…»; llegaron %d", domain.QuoteLen, len([]rune(q.Body)))
	}
}
