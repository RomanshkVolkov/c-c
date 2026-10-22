package service

import (
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Lo que escribe un agente en un canal o en un directo queda marcado, y vuelve
// marcado al leer (22-oct-2026). El token es la persona: sin la marca, un
// mensaje de un agente se lee como si lo hubiera tecleado ella.
//
// Roturas que detecta: no guardar la marca; no devolverla al leer el canal o
// el directo; marcar lo que se escribió desde la app; o aceptar una marca que
// no es de la lista cerrada (cualquier cadena acabaría pintada como etiqueta).
func TestAnAgentsMessageSaysItCameFromAnAgent(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	chat := NewChatService(repository.NewChatRepository(db), nil)

	agente, err := chat.ReplyVia(domain.ViaMCP, "esp-1", "org-1", ana, "El deploy de las 9 salió", "")
	if err != nil {
		t.Fatal(err)
	}
	persona, err := chat.Reply("esp-1", "org-1", ana, "Gracias", "")
	if err != nil {
		t.Fatal(err)
	}
	raro, err := chat.ReplyVia("jefe", "esp-1", "org-1", ana, "x", "")
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := chat.List("esp-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	via := map[string]string{}
	for _, m := range msgs {
		via[m.ID] = m.Via
	}
	if via[agente.ID] != domain.ViaMCP || via[persona.ID] != "" || via[raro.ID] != "" {
		t.Fatalf("canal: agente %q, persona %q, marca desconocida %q", via[agente.ID], via[persona.ID], via[raro.ID])
	}
}

func TestAnAgentsDirectMessageSaysItCameFromAnAgent(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	dms := NewDMService(repo, nil)
	c, _ := repo.OpenWith("org-1", "u-ana", "u-bea")

	agente, err := dms.ReplyVia(domain.ViaMCP, c.ID, "u-ana", "Te dejé el PR listo", "")
	if err != nil {
		t.Fatal(err)
	}
	persona, err := dms.Post(c.ID, "u-ana", "y un café")
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := repo.List(c.ID, time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	via := map[string]string{}
	for _, m := range msgs {
		via[m.ID] = m.Via
	}
	if via[agente.ID] != domain.ViaMCP || via[persona.ID] != "" {
		t.Fatalf("directo: agente %q, persona %q", via[agente.ID], via[persona.ID])
	}
}
