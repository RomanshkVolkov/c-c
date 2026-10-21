package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type fakeContext struct {
	resolvedWith []string
	mapped       string
}

func (f *fakeContext) FindSpace(id string) (*domain.TaskSpace, error) {
	if id == "sp-ajeno" {
		return &domain.TaskSpace{OrgID: "org-2"}, nil
	}
	if id == "sp-1" {
		return &domain.TaskSpace{OrgID: "org-1"}, nil
	}
	return nil, errors.New("not found")
}

func (f *fakeContext) ResolveRepo(name string, orgIDs []string) (string, string, error) {
	f.resolvedWith = orgIDs
	if strings.EqualFold(name, "guz-studio/cac") {
		return "sp-1", "org-1", nil
	}
	return "", "", service.ErrContextRepoNotLinked
}

func (f *fakeContext) Map(orgID, spaceID string, repo *domain.ContextRepo) (domain.ContextMap, error) {
	f.mapped = orgID + "/" + spaceID
	return domain.ContextMap{}, nil
}

func contextReq(t *testing.T, h *ContextHandler, query string, claims *domain.ClaimsJWT) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/context?"+query, nil)
	r = r.WithContext(context.WithValue(r.Context(), repository.UserContextKey, claims))
	rec := httptest.NewRecorder()
	h.Get(rec, r)
	return rec
}

// Roturas que detectan, en orden: no contestar a un miembro; dar el mapa de
// un espacio de otra organización (o decir que existe con un 403); resolver
// el repo entre todas las organizaciones a un superadmin, que es lo que haría
// colarse el proyecto de otra con el mismo nombre; no decir por qué un repo no
// se encontró; aceptar una petición sin espacio ni repo.
func TestWhoGetsTheContextMap(t *testing.T) {
	ana := &domain.ClaimsJWT{UserID: "u-ana", Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleViewer}}}
	root := &domain.ClaimsJWT{UserID: "u-root", Superadmin: true, Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleAdmin}}}

	f := &fakeContext{}
	h := &ContextHandler{svc: f}
	if rec := contextReq(t, h, "spaceId=sp-1", ana); rec.Code != http.StatusOK || f.mapped != "org-1/sp-1" {
		t.Fatalf("miembro (aunque sea lector): %d %q", rec.Code, f.mapped)
	}
	f.mapped = ""
	if rec := contextReq(t, h, "spaceId=sp-ajeno", ana); rec.Code != http.StatusNotFound || f.mapped != "" {
		t.Fatalf("espacio de otra org: %d %q", rec.Code, f.mapped)
	}
	if rec := contextReq(t, h, "repo=Guz-Studio/cac", root); rec.Code != http.StatusOK || strings.Join(f.resolvedWith, ",") != "org-1" {
		t.Fatalf("el repo se resolvió fuera de sus orgs: %d %v", rec.Code, f.resolvedWith)
	}
	rec := contextReq(t, h, "repo=acme/x", ana)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "context-repo-not-linked") {
		t.Fatalf("repo sin espacio: %d %s", rec.Code, rec.Body.String())
	}
	if rec := contextReq(t, h, "", ana); rec.Code != http.StatusBadRequest {
		t.Fatalf("sin destino: %d", rec.Code)
	}
}
