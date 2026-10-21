package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Roturas que detecta: guardar las búsquedas de la app (una persona reformula
// en el momento; sólo interesan las del agente), guardar las que sí dieron
// algo, o contar como acierto lo que el agente no ve (una persona, un mensaje).
func TestOnlyAnAgentSearchThatFoundNothingIsRecorded(t *testing.T) {
	mcp := domain.WithVia(context.Background(), domain.ViaMCP)
	app := context.Background()
	nada := domain.SearchResults{}
	conDoc := domain.SearchResults{Docs: []domain.SearchHit{{ID: "d"}}}
	conTarea := domain.SearchResults{Tasks: []domain.SearchHit{{ID: "t"}}}
	conNota := domain.SearchResults{Notes: []domain.SearchHit{{ID: "n"}}}
	soloGente := domain.SearchResults{People: []domain.SearchHit{{ID: "p"}}, Messages: []domain.SearchHit{{ID: "m"}}}

	if !agentFoundNothing(mcp, nada) {
		t.Error("una búsqueda vacía del agente no se guarda")
	}
	if !agentFoundNothing(mcp, soloGente) {
		t.Error("personas y mensajes no le llegan al agente: no es un acierto")
	}
	for _, r := range []domain.SearchResults{conDoc, conTarea, conNota} {
		if agentFoundNothing(mcp, r) {
			t.Errorf("con aciertos se guardó como fallida: %+v", r)
		}
	}
	if agentFoundNothing(app, nada) {
		t.Error("se guarda una búsqueda de la app")
	}
}

type fakeSearcher struct {
	res    domain.SearchResults
	missed []string
}

func (f *fakeSearcher) Search(q, orgID, userID string, limit int) (domain.SearchResults, error) {
	return f.res, nil
}
func (f *fakeSearcher) SearchOrgs(q string, orgIDs []string, userID string, limit int) (domain.SearchResults, error) {
	return f.res, nil
}
func (f *fakeSearcher) RecordMiss(userID, orgID, q string) error {
	f.missed = append(f.missed, userID+"|"+orgID+"|"+q)
	return nil
}

// Rotura que detecta: que el handler no llame a guardarla, o la guarde con
// otra persona u otra consulta.
func TestTheSearchHandlerRecordsAnAgentMiss(t *testing.T) {
	f := &fakeSearcher{}
	h := &searchHandler{svc: f}
	claims := &domain.ClaimsJWT{UserID: "u-ana", Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}}}
	req := func(via string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/search/?q=como+despliego&orgId=org-1", nil)
		ctx := context.WithValue(r.Context(), repository.UserContextKey, claims)
		return r.WithContext(domain.WithVia(ctx, via))
	}
	h.Search(httptest.NewRecorder(), req(domain.ViaMCP))
	h.Search(httptest.NewRecorder(), req(domain.ViaApp))
	if len(f.missed) != 1 || f.missed[0] != "u-ana|org-1|como despliego" {
		t.Fatalf("guardadas: %v", f.missed)
	}
}
