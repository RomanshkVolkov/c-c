package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// El chat de la llamada para el invitado (tanda 4): entra con el enlace y su
// pase, **admitido** y con la llamada **abierta**. Mutantes: no mirar si está
// admitido; dejarle seguir con la llamada terminada; firmar con otro nombre.

func TestAGuestChatsOnlyWhileInsideTheCall(t *testing.T) {
	h, db := callTestHandler(t)
	if err := db.AutoMigrate(&domain.CallSession{}, &domain.CallSessionParticipant{},
		&domain.CallMessage{}, &domain.ChatReaction{}); err != nil {
		t.Fatal(err)
	}
	calls := service.NewCallSessionService(repository.NewCallSessionRepository(db), nil, nil)
	h.calls = calls

	rec, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("la invitación: %d %s", rec.Code, rec.Body.String())
	}
	link := repository.SignCallInviteLink(inv.ID)
	asked, err := h.svc.JoinAsGuest(link, "Cliente", "")
	if err != nil {
		t.Fatal(err)
	}
	chat := func(path string, body string) *httptest.ResponseRecorder {
		r := httptest.NewRecorder()
		req := callReq(http.MethodPost, path, map[string]string{"token": link, "pass": asked.Pass, "body": body}, nil, nil)
		if strings.HasSuffix(path, "/send") {
			h.PublicChatSend(r, req)
		} else {
			h.PublicChat(r, req)
		}
		return r
	}

	if r := chat("/api/v1/public/calls/chat", ""); r.Code != http.StatusForbidden || !strings.Contains(r.Body.String(), "guest-not-admitted") {
		t.Fatalf("quien espera no lee el chat: %d %s", r.Code, r.Body.String())
	}

	guestID, ok := repository.VerifyGuestPass(inv.ID, asked.Pass, time.Now())
	if !ok {
		t.Fatal("el pase no vale")
	}
	full, err := h.svc.Find(inv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Admit(full, guestID, "u-ana"); err != nil {
		t.Fatal(err)
	}
	if r := chat("/api/v1/public/calls/chat", ""); r.Code != http.StatusConflict {
		t.Fatalf("sin llamada abierta no hay chat: %d %s", r.Code, r.Body.String())
	}

	id := full.ID
	session := calls.Open("org-1", nil, full.Room(), &id, "u-ana")
	if r := chat("/api/v1/public/calls/chat/send", "  hola  "); r.Code != http.StatusCreated {
		t.Fatalf("el invitado admitido escribe: %d %s", r.Code, r.Body.String())
	}
	r := chat("/api/v1/public/calls/chat", "")
	var res struct {
		Data []domain.CallMessageResponse `json:"data"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &res)
	if r.Code != http.StatusOK || len(res.Data) != 1 || res.Data[0].Body != "hola" ||
		res.Data[0].AuthorName != "Cliente" || res.Data[0].AuthorGuestID == nil || res.Data[0].AuthorUserID != nil {
		t.Fatalf("lo suyo, firmado con su nombre de invitado: %d %+v", r.Code, res.Data)
	}

	if _, err := repository.NewCallSessionRepository(db).Close(session, time.Now()); err != nil {
		t.Fatal(err)
	}
	if r := chat("/api/v1/public/calls/chat", ""); r.Code != http.StatusConflict {
		t.Errorf("terminada la llamada, el invitado deja de verlo: %d", r.Code)
	}
}

// Reaccionar a un mensaje del chat de la llamada, como miembro: un emoji fuera
// del juego es un 400, y dos veces el mismo no duplica. Mutantes: no validar el
// emoji; contar dos veces.
func TestReactingInTheCallChat(t *testing.T) {
	_, db := callTestHandler(t)
	if err := db.AutoMigrate(&domain.CallSession{}, &domain.CallSessionParticipant{},
		&domain.CallMessage{}, &domain.ChatReaction{}); err != nil {
		t.Fatal(err)
	}
	calls := service.NewCallSessionService(repository.NewCallSessionRepository(db), nil, nil)
	sp := "esp-1"
	cs, _ := calls.Find(calls.Open("org-1", &sp, "voice:esp-1", nil, "u-ana"))
	m, err := calls.PostMessage(cs, "u-ana", "ana", "listo")
	if err != nil {
		t.Fatal(err)
	}
	if err := calls.React(cs, m.ID, "u-bea", "💩", true); err != service.ErrBadReaction {
		t.Errorf("fuera del juego: %v", err)
	}
	for range 2 {
		if err := calls.React(cs, m.ID, "u-bea", "👍", true); err != nil {
			t.Fatal(err)
		}
	}
	msgs, _ := calls.Messages(cs.ID, "u-bea")
	if len(msgs) != 1 || len(msgs[0].Reactions) != 1 || msgs[0].Reactions[0].Count != 1 || !msgs[0].Reactions[0].Mine {
		t.Fatalf("una reacción, mía: %+v", msgs)
	}
	if err := calls.React(cs, m.ID, "u-bea", "👍", false); err != nil {
		t.Fatal(err)
	}
	if msgs, _ := calls.Messages(cs.ID, "u-bea"); len(msgs[0].Reactions) != 0 {
		t.Errorf("quitarla la quita: %+v", msgs[0].Reactions)
	}
}
