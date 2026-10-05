package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// La actividad de una org la ve cualquiera de la org, y nadie más: a quien no
// es miembro se le contesta que la org no existe (404), igual que en el resto
// de `/organizations/{id}`. Un superadmin la ve sin ser miembro. Y los
// parámetros llegan al feed. El mutante que mata: montar la ruta sin
// `scopeOrg`.
func TestActivityIsOnlyForMembers(t *testing.T) {
	db, cleanup := githubDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.User{}, &domain.WorkflowRun{}, &domain.Deployable{}, &domain.Deployment{}); err != nil {
		t.Fatal(err)
	}
	run := &domain.WorkflowRun{OrgID: "org-1", RepoID: 100, RepoFullName: "dwit/api", RunID: 9, RunAttempt: 1,
		Status: domain.RunStatusCompleted, Conclusion: "success", Path: ".github/workflows/prod.yml",
		WorkflowName: "Deploy", OccurredAt: time.Now()}
	run.ID = "run-1"
	if _, _, err := repository.NewActivityRepository(db).UpsertRun(run); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	InitActivityRoutes(db, r)

	call := func(path string, superadmin bool, orgs ...domain.OrgMembershipClaim) *httptest.ResponseRecorder {
		pair, err := repository.GenerateTokens("u-1", "ana", superadmin, orgs)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	viewer := domain.OrgMembershipClaim{OrgID: "org-1", Role: domain.OrgRoleViewer}
	outsider := domain.OrgMembershipClaim{OrgID: "org-2", Role: domain.OrgRoleAdmin}

	if rec := call("/api/v1/organizations/org-1/activity/", false, viewer); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), `"runId":9`) {
		t.Errorf("un viewer de la org → %d %s", rec.Code, rec.Body.String())
	}
	if rec := call("/api/v1/organizations/org-1/activity/", false, outsider); rec.Code != http.StatusNotFound {
		t.Errorf("alguien de otra org → %d, se esperaba 404", rec.Code)
	}
	if rec := call("/api/v1/organizations/org-1/activity/", true); rec.Code != http.StatusOK {
		t.Errorf("un superadmin → %d", rec.Code)
	}
	if rec := call("/api/v1/organizations/org-1/activity/?repo=dwit/web", false, viewer); rec.Code != http.StatusOK ||
		strings.Contains(rec.Body.String(), `"runId":9`) {
		t.Errorf("el filtro por repo no llegó al feed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := call("/api/v1/organizations/org-1/activity/?before=ayer", false, viewer); rec.Code != http.StatusBadRequest {
		t.Errorf("un cursor que no es una fecha → %d, se esperaba 400", rec.Code)
	}
}
