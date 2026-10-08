package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

func pageHandler(t *testing.T) *docHandler {
	t.Helper()
	db, cleanup := docOrgDB(t)
	t.Cleanup(cleanup)
	if err := db.AutoMigrate(&domain.DocTab{}, &domain.DocVersion{}, &domain.DocAttachment{},
		&domain.DocPage{}, &domain.DocPageVersion{}, &domain.User{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureSearchIndexes(db); err != nil {
		t.Fatal(err)
	}
	return &docHandler{svc: service.NewDocService(repository.NewDocRepository(db))}
}

func pageReq(method, space, pageID string, body any) *http.Request {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	r := httptest.NewRequest(method, "/x", &buf)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("kind", "space")
	rctx.URLParams.Add("ownerId", space)
	if pageID != "" {
		rctx.URLParams.Add("pageId", pageID)
	}
	claims := &domain.ClaimsJWT{UserID: "u-ana", Username: "ana",
		Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember},
			{OrgID: "org-2", Role: domain.OrgRoleMember}}}
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, repository.UserContextKey, claims)
	return r.WithContext(ctx)
}

func createPage(t *testing.T, h *docHandler, space, title, body string) domain.DocPage {
	t.Helper()
	rec := httptest.NewRecorder()
	h.CreatePage(rec, pageReq(http.MethodPost, space, "", map[string]string{"title": title, "body": body}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("crear → %d: %s", rec.Code, rec.Body.String())
	}
	var res struct{ Data domain.DocPage }
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	return res.Data
}

// Un guardado con un hash viejo se rechaza con la página actual dentro.
//
// El mutante que mata: no mirar `baseHash`. Un agente que reescribe una página
// mientras alguien la tiene abierta borraría lo que esa persona escribió.
func TestAStalePageHashIs409WithTheCurrentPage(t *testing.T) {
	h := pageHandler(t)
	p := createPage(t, h, "esp-1", "Nereus", "v1")

	viejo := "no-es-el-hash"
	rec := httptest.NewRecorder()
	h.SavePage(rec, pageReq(http.MethodPut, "esp-1", p.ID, map[string]any{"body": "pisado", "baseHash": viejo}))
	if rec.Code != http.StatusConflict {
		t.Fatalf("un hash viejo → %d", rec.Code)
	}
	var res struct{ Data domain.DocPage }
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Data.Body != "v1" || res.Data.BodyHash != p.BodyHash {
		t.Fatalf("el 409 no trae la página actual: %+v", res.Data)
	}
	// Con el hash bueno, sí.
	rec = httptest.NewRecorder()
	h.SavePage(rec, pageReq(http.MethodPut, "esp-1", p.ID, map[string]any{"body": "v2", "baseHash": p.BodyHash}))
	if rec.Code != http.StatusOK {
		t.Fatalf("con el hash bueno → %d: %s", rec.Code, rec.Body.String())
	}
}

// Una página de otro documento no existe bajo esta URL.
//
// El mutante que mata: buscar la página sólo por id, sin el documento. Un id de
// página de otro cliente puesto bajo un nodo propio se abriría y se podría
// pisar.
func TestAPageOfAnotherDocIs404(t *testing.T) {
	h := pageHandler(t)
	ajena := createPage(t, h, "esp-2", "De otro cliente", "secreto")
	// El nodo de la URL **tiene** documento: si no, el 404 saldría antes de
	// buscar la página y la guarda que se prueba no se ejercitaría.
	createPage(t, h, "esp-1", "Propia", "")

	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"get": h.GetPage, "save": h.SavePage, "trash": h.TrashPage,
	} {
		rec := httptest.NewRecorder()
		call(rec, pageReq(http.MethodPost, "esp-1", ajena.ID, map[string]any{"body": "x"}))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s de una página de otro doc → %d", name, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "secreto") {
			t.Errorf("%s enseña el texto de otro doc", name)
		}
	}
}

// Un texto por encima del tope es un 413 que lo dice, no un error de la base.
func TestAnOversizedPageIs413(t *testing.T) {
	h := pageHandler(t)
	rec := httptest.NewRecorder()
	h.CreatePage(rec, pageReq(http.MethodPost, "esp-1", "",
		map[string]string{"title": "Enorme", "body": strings.Repeat("a", domain.MaxDocBodyChars+1)}))
	if rec.Code != http.StatusRequestEntityTooLarge || !strings.Contains(rec.Body.String(), "body-too-large") {
		t.Fatalf("un cuerpo enorme → %d: %.200s", rec.Code, rec.Body.String())
	}
}
