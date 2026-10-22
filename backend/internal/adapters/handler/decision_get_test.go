package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Una decisión se lee suelta, por su id, con su cuerpo y el nodo del que es
// (22-oct-2026): es lo que la búsqueda y el mapa dan, y hasta entonces no
// había ruta para leerla. Quien no es de su organización recibe 404, como con
// el documento: no se dice que existe.
//
// Roturas que detecta: no comprobar la organización (la de otro cliente se
// leería por su id); no decir de qué nodo es; o contestar algo distinto de 404
// a lo que no existe.
func TestADecisionIsReadByItsIdOnlyInsideItsOrganization(t *testing.T) {
	db, cleanup := docOrgDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.Decision{}); err != nil {
		t.Fatal(err)
	}
	doc := &domain.Doc{OrgID: "org-1", OwnerKind: domain.DocOwnerSpace, OwnerID: "esp-1"}
	doc.ID = "doc-1"
	if err := db.Create(doc).Error; err != nil {
		t.Fatal(err)
	}
	d := &domain.Decision{DocID: "doc-1", Title: "Las releases se juntan", Body: "Una por arreglo gastaba números", Origin: "doc", DecidedAt: time.Now()}
	d.ID = "dec-1"
	if err := db.Create(d).Error; err != nil {
		t.Fatal(err)
	}
	h := &docHandler{svc: service.NewDocService(repository.NewDocRepository(db))}

	pide := func(id string, claims *domain.ClaimsJWT) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/docs/decisions/"+id, nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", id)
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
		ctx = context.WithValue(ctx, repository.UserContextKey, claims)
		rec := httptest.NewRecorder()
		h.GetDecision(rec, r.WithContext(ctx))
		return rec
	}
	deAqui := &domain.ClaimsJWT{UserID: "u-1", Username: "uno", Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: "member"}}}
	deOtra := &domain.ClaimsJWT{UserID: "u-2", Username: "dos", Orgs: []domain.OrgMembershipClaim{{OrgID: "org-2", Role: "member"}}}

	rec := pide("dec-1", deAqui)
	if rec.Code != http.StatusOK {
		t.Fatalf("un miembro tiene que poder leerla: %d %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Data struct {
			Decision  domain.Decision `json:"decision"`
			OwnerKind string          `json:"ownerKind"`
			OwnerID   string          `json:"ownerId"`
			OrgID     string          `json:"orgId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Data.Decision.Body != "Una por arreglo gastaba números" || res.Data.OwnerKind != "space" || res.Data.OwnerID != "esp-1" || res.Data.OrgID != "org-1" {
		t.Fatalf("tiene que venir el cuerpo y de qué nodo es: %+v", res.Data)
	}
	if rec := pide("dec-1", deOtra); rec.Code != http.StatusNotFound {
		t.Fatalf("la de otra organización no existe para quien no es de ella: %d", rec.Code)
	}
	if rec := pide("no-existe", deAqui); rec.Code != http.StatusNotFound {
		t.Fatalf("lo que no existe es 404: %d", rec.Code)
	}
}
