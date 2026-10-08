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

// Lo de GitHub de una tarea es de su organización: a quien no es de ella, 404.
//
// El mutante que mata: quitar `resolveTask` (o pedir la tarea sin autorizar).
// Las PRs de un cliente —títulos, ramas, autores— se verían desde otra org.
func TestTheGitHubLinksOfATaskAreFenced(t *testing.T) {
	db, cleanup := docOrgDB(t)
	defer cleanup()
	if err := db.AutoMigrate(&domain.Item{}, &domain.TaskGitLink{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.Item{BaseModel: domain.BaseModel{ID: "it-1"}, OrgID: "org-1", SpaceID: "esp-1", Seq: 1, Title: "x"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.TaskGitLink{OrgID: "org-1", ItemID: "it-1", RepoID: 1, RepoFullName: "dwit/api",
		Kind: domain.GitLinkPR, Key: "3", Title: "secreto", State: domain.PRStateOpen, OccurredAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	repo := repository.NewTaskRepository(db)
	h := &taskHandler{svc: service.NewTaskService(repo, repository.NewReportRepository(db),
		repository.NewOrganizationRepository(db), nil), repo: repo}

	call := func(org string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/tasks/it-1/git", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "it-1")
		claims := &domain.ClaimsJWT{UserID: "u", Username: "u",
			Orgs: []domain.OrgMembershipClaim{{OrgID: org, Role: domain.OrgRoleMember}}}
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
		ctx = context.WithValue(ctx, repository.UserContextKey, claims)
		rec := httptest.NewRecorder()
		h.TaskGit(rec, r.WithContext(ctx))
		return rec
	}
	if rec := call("org-2"); rec.Code != http.StatusNotFound {
		t.Fatalf("otra organización → %d: %s", rec.Code, rec.Body.String())
	}
	rec := call("org-1")
	var res struct{ Data domain.TaskGitLinks }
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if rec.Code != http.StatusOK || len(res.Data.PRs) != 1 || res.Data.Summary.PRBadge != domain.PRStateOpen {
		t.Fatalf("la propia org → %d %+v", rec.Code, res.Data)
	}
}
