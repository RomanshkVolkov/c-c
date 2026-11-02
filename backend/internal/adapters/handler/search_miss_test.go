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
	res         domain.SearchResults
	missed      []string
	missesAsked []string
}

func (f *fakeSearcher) Search(q, orgID, userID string, limit int) (domain.SearchResults, error) {
	return f.res, nil
}
func (f *fakeSearcher) SearchOrgs(q string, orgIDs []string, userID string, limit int) (domain.SearchResults, error) {
	return f.res, nil
}
func (f *fakeSearcher) Misses(orgID string, unscoped bool, days int) ([]domain.SearchMissSummary, error) {
	f.missesAsked = append(f.missesAsked, orgID)
	return []domain.SearchMissSummary{}, nil
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

// Las búsquedas fallidas son de todo el equipo, y el texto de una puede ser de
// algo que quien pregunta no ve: sólo un admin de la org, o un superadmin.
//
// Roturas que atrapa: dejar leer a un miembro raso; dejar leer a un admin de
// otra org; no pasar la org pedida al servicio.
func TestOnlyAnAdminOfTheOrgReadsItsFailedSearches(t *testing.T) {
	ask := func(c *domain.ClaimsJWT, org string) (int, *fakeSearcher) {
		f := &fakeSearcher{}
		h := &searchHandler{svc: f}
		r := httptest.NewRequest(http.MethodGet, "/api/v1/search/misses?orgId="+org, nil)
		r = r.WithContext(context.WithValue(r.Context(), repository.UserContextKey, c))
		rec := httptest.NewRecorder()
		h.Misses(rec, r)
		return rec.Code, f
	}
	in := func(org string, role domain.OrgRole) *domain.ClaimsJWT {
		return &domain.ClaimsJWT{UserID: "u", Orgs: []domain.OrgMembershipClaim{{OrgID: org, Role: role}}}
	}
	if code, _ := ask(in("org-1", domain.OrgRoleMember), "org-1"); code != http.StatusForbidden {
		t.Errorf("un miembro raso lee: %d", code)
	}
	if code, _ := ask(in("org-2", domain.OrgRoleAdmin), "org-1"); code != http.StatusForbidden {
		t.Errorf("un admin de otra org lee: %d", code)
	}
	if code, _ := ask(in("org-1", domain.OrgRoleAdmin), ""); code != http.StatusForbidden {
		t.Errorf("un admin sin org lee todas: %d", code)
	}
	code, f := ask(in("org-1", domain.OrgRoleAdmin), "org-1")
	if code != http.StatusOK || len(f.missesAsked) != 1 || f.missesAsked[0] != "org-1" {
		t.Errorf("el admin de la org: %d %v", code, f.missesAsked)
	}
	if code, _ := ask(&domain.ClaimsJWT{UserID: "root", Superadmin: true}, ""); code != http.StatusOK {
		t.Errorf("un superadmin no lee: %d", code)
	}
}

// Sin `orgId` (lo normal en el MCP), un token de una sola org guarda la
// búsqueda con ésa; con varias, sin org, porque no se sabe de cuál era.
//
// Rotura que atrapa: guardarla siempre sin org (como hasta el 2-nov-2026, y
// la revisión no podía separarlas), o con la primera de varias.
func TestAMissWithoutOrgKeepsTheOnlyOrgOfTheToken(t *testing.T) {
	one := &domain.ClaimsJWT{Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1"}}}
	two := &domain.ClaimsJWT{Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1"}, {OrgID: "org-2"}}}
	if got := missOrg(one, ""); got != "org-1" {
		t.Errorf("una sola org: %q", got)
	}
	if got := missOrg(two, ""); got != "" {
		t.Errorf("varias orgs: %q", got)
	}
	if got := missOrg(two, "org-2"); got != "org-2" {
		t.Errorf("la pedida: %q", got)
	}
}
