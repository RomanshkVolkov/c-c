package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Las puertas de las reuniones con invitados viven en el handler: el servicio
// acuña lo que se le pide. Estas pruebas son las que vigilan **a quién** se le
// deja pedir.

func callTestHandler(t *testing.T) (*callHandler, *gorm.DB) {
	t.Helper()
	db, cleanup := voiceDB(t)
	t.Cleanup(cleanup)
	if err := db.AutoMigrate(&domain.CallInvite{}, &domain.CallGuest{},
		&domain.Recording{}, &domain.RecordingTrack{}); err != nil {
		t.Fatal(err)
	}
	voice := service.NewVoiceService("wss://rtc.example", "APIabc", "un-secreto-largo-de-prueba")
	rec := service.NewRecordingService(repository.NewRecordingRepository(db), nil, nil,
		mediastore.Fake(), "recordings", false, 240)
	svc := service.NewCallInviteService(repository.NewCallInviteRepository(db), voice, nil, rec)
	return NewCallHandler(svc, rec, voice, repository.NewTaskRepository(db)).(*callHandler), db
}

func member(org string, role domain.OrgRole) *domain.ClaimsJWT {
	return &domain.ClaimsJWT{
		UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: org, Role: role}},
	}
}

func callReq(method, path string, body any, claims *domain.ClaimsJWT, params map[string]string) *http.Request {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	r := httptest.NewRequest(method, path, &buf)
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	if claims != nil {
		ctx = context.WithValue(ctx, repository.UserContextKey, claims)
	}
	return r.WithContext(ctx)
}

func createInvite(t *testing.T, h *callHandler, claims *domain.ClaimsJWT, spaceID string) (*httptest.ResponseRecorder, domain.CallInviteResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Create(rec, callReq(http.MethodPost, "/api/v1/call-invites", map[string]any{
		"orgId": "org-1", "spaceId": spaceID, "title": "Con el cliente",
	}, claims, nil))
	var res struct {
		Data domain.CallInviteResponse `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	return rec, res.Data
}

// A quien no es de la organización, 404: ni la invitación existe.
//
// El mutante que mata: quitar `authorizeOrg` de `invite`. Cualquier usuario de
// cac con el id de una reunión ajena sacaría su enlace y entraría como miembro.
func TestAnOutsiderGets404OnAnotherOrgsInvite(t *testing.T) {
	h, _ := callTestHandler(t)
	rec, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "esp-1")
	if rec.Code != http.StatusCreated {
		t.Fatalf("crear → %d: %s", rec.Code, rec.Body.String())
	}

	outsider := member("org-2", domain.OrgRoleAdmin)
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"get": h.Get, "token": h.Token, "revoke": h.Revoke, "kick": h.Kick,
		"waiting": h.Waiting, "admit": h.Admit, "reject": h.Reject, "ring": h.Ring,
	} {
		rec := httptest.NewRecorder()
		call(rec, callReq(http.MethodPost, "/x", nil, outsider,
			map[string]string{"id": inv.ID, "identity": "guest:x", "guestId": "g"}))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s de una reunión ajena → %d, se esperaba 404", name, rec.Code)
		}
		if contiene(rec.Body.String(), inv.Link) {
			t.Errorf("%s enseña el enlace a alguien de fuera", name)
		}
	}
}

// Una invitación no puede colgar del canal de otra organización.
//
// El mutante que mata: no comprobar que el canal es de la org. Entonces mi
// reunión grabaría y anunciaría en el canal de otro cliente.
func TestAnInviteCannotHangFromAnotherOrgsChannel(t *testing.T) {
	h, _ := callTestHandler(t)
	rec, _ := createInvite(t, h, member("org-1", domain.OrgRoleMember), "esp-ajeno")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("colgar de un canal ajeno → %d, se esperaba 404", rec.Code)
	}
}

// Quien sólo lee no abre reuniones ni echa a nadie.
//
// El mutante que mata: quitar `needWrite` de `Create` o de `Kick`.
func TestAViewerCannotCreateOrKick(t *testing.T) {
	h, _ := callTestHandler(t)
	viewer := member("org-1", domain.OrgRoleViewer)
	if rec, _ := createInvite(t, h, viewer, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("un lector crea una reunión → %d", rec.Code)
	}

	_, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "")
	rec := httptest.NewRecorder()
	h.Kick(rec, callReq(http.MethodPost, "/x", nil, viewer,
		map[string]string{"id": inv.ID, "identity": "guest:x"}))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("un lector echa a un invitado → %d", rec.Code)
	}
}

// Quien sólo lee no decide quién entra.
//
// El mutante que mata: quitar `needWrite` de `Admit`. Un lector de la
// organización podría abrirle la puerta a cualquiera.
func TestAViewerCannotLetAnyoneIn(t *testing.T) {
	h, _ := callTestHandler(t)
	_, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "")
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){"admit": h.Admit, "reject": h.Reject} {
		rec := httptest.NewRecorder()
		call(rec, callReq(http.MethodPost, "/x", nil, member("org-1", domain.OrgRoleViewer),
			map[string]string{"id": inv.ID, "guestId": "g"}))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("un lector puede %s → %d", name, rec.Code)
		}
	}
}

// Revocar es de quien la abrió o de quien administra.
func TestOnlyTheHostOrAnAdminRevokes(t *testing.T) {
	h, _ := callTestHandler(t)
	_, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "")

	other := &domain.ClaimsJWT{UserID: "u-otro", Username: "otro",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}}}
	rec := httptest.NewRecorder()
	h.Revoke(rec, callReq(http.MethodDelete, "/x", nil, other, map[string]string{"id": inv.ID}))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("otro miembro revoca la reunión de un compañero → %d", rec.Code)
	}

	admin := &domain.ClaimsJWT{UserID: "u-jefa", Username: "jefa",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleAdmin}}}
	rec = httptest.NewRecorder()
	h.Revoke(rec, callReq(http.MethodDelete, "/x", nil, admin, map[string]string{"id": inv.ID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("una admin no puede revocar → %d", rec.Code)
	}
}

// El token de un miembro es para la sala de la reunión.
func TestTheMemberMeetTokenIsForTheMeetRoom(t *testing.T) {
	h, _ := callTestHandler(t)
	_, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "esp-1")

	rec := httptest.NewRecorder()
	h.Token(rec, callReq(http.MethodPost, "/x", nil, member("org-1", domain.OrgRoleViewer),
		map[string]string{"id": inv.ID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("un miembro no entra a su reunión → %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Data domain.MeetTokenResponse `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Data.Room != domain.MeetRoomFor(inv.ID) || res.Data.InviteID != inv.ID {
		t.Fatalf("el token de la reunión es para %q", res.Data.Room)
	}
}

// Lo que se enseña a alguien de fuera no lleva ningún id.
//
// El mutante que mata: devolver la invitación tal cual. Un enlace reenviado le
// contaría a cualquiera los ids de la organización, del canal y de quien invita.
func TestThePublicInspectRevealsNoIDs(t *testing.T) {
	h, _ := callTestHandler(t)
	_, inv := createInvite(t, h, member("org-1", domain.OrgRoleMember), "esp-1")

	rec := httptest.NewRecorder()
	h.PublicInspect(rec, callReq(http.MethodPost, "/api/v1/public/calls/inspect",
		map[string]string{"token": inv.Link}, nil, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("inspect → %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, id := range []string{inv.ID, "org-1", "esp-1", "u-ana"} {
		if contiene(body, id) {
			t.Errorf("la vista pública enseña %q: %s", id, body)
		}
	}
	if !contiene(body, "Uno") || !contiene(body, "Con el cliente") {
		t.Errorf("la vista pública no dice de quién es ni qué es: %s", body)
	}
}

// La puerta pública tiene límite.
//
// El mutante que mata: quitar `allow`. Sin él, probar enlaces a ciegas sale
// gratis, y un enlace filtrado deja entrar a quien quiera tantas veces como
// quiera.
func TestJoinIsRateLimited(t *testing.T) {
	h, _ := callTestHandler(t)
	last := 0
	for i := 0; i <= publicCallPerIPPerHour; i++ {
		rec := httptest.NewRecorder()
		h.PublicInspect(rec, callReq(http.MethodPost, "/api/v1/public/calls/inspect",
			map[string]string{"token": "nada.malo"}, nil, nil))
		last = rec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("la petición %d desde la misma IP → %d, se esperaba 429",
			publicCallPerIPPerHour+1, last)
	}
}

// Un enlace malo y una invitación que no existe contestan lo mismo.
func TestABadLinkSaysNothingAboutWhatExists(t *testing.T) {
	h, _ := callTestHandler(t)
	rec := httptest.NewRecorder()
	h.PublicJoin(rec, callReq(http.MethodPost, "/api/v1/public/calls/join",
		map[string]string{"token": repository.SignCallInviteLink("no-existe"), "name": "Ana"}, nil, nil))
	if rec.Code != http.StatusNotFound || !contiene(rec.Body.String(), "invite-invalid") {
		t.Fatalf("una invitación inexistente → %d %s", rec.Code, rec.Body.String())
	}
}
