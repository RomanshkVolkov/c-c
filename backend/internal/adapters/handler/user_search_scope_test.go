package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Asking for somebody else's colleagues.
//
// The search takes the organization to narrow to from the query string, which
// means the caller chooses it. Taken on trust, that turns one endpoint into a
// directory of every client's people — and the two features built on top of it
// exist precisely to *not* offer those names: you cannot mention or message
// someone outside your own organization.
//
// This is checked here rather than in the repository because the repository is
// told which org to search and dutifully searches it. Deciding whether the
// caller may ask is the handler's job, and a mutation that removes the check
// passes every repository test.

// req builds a search request carrying the given claims.
func searchReq(orgID string, claims *domain.ClaimsJWT) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/users/search?q=a&orgId="+orgID, nil)
	ctx := r.Context()
	return r.WithContext(context.WithValue(ctx, repository.UserContextKey, claims))
}

func TestYouCannotSearchAnOrganizationYouDoNotBelongTo(t *testing.T) {
	mine := &domain.ClaimsJWT{
		UserID: "u-ana",
		Orgs:   []domain.OrgMembershipClaim{{OrgID: "org-1", Role: "member"}},
	}

	rec := httptest.NewRecorder()
	h := &userHandler{}
	h.Search(rec, searchReq("org-de-otro-cliente", mine))

	if rec.Code != http.StatusForbidden {
		t.Errorf("asking for another organization's people → %d, want 403", rec.Code)
	}
}

// A superadmin is not exempt here, and that is the point rather than an
// oversight.
//
// They can see every organization, so the looser rule felt natural — and it
// produced a picker that offered people the server then refused to open a
// conversation with, because *that* check asks for real membership. Two answers
// to one question is how "not-colleagues" reached a screen. A superadmin who
// wants to take part joins the organization.
func TestASuperadminOutsideTheOrganizationIsAlsoRefused(t *testing.T) {
	root := &domain.ClaimsJWT{UserID: "u-root", Superadmin: true}

	rec := httptest.NewRecorder()
	h := &userHandler{}
	h.Search(rec, searchReq("org-1", root))

	if rec.Code != http.StatusForbidden {
		t.Errorf("a superadmin who is not a member → %d, want 403: the picker must not offer what opening a conversation refuses", rec.Code)
	}
}

// And the ordinary case still works, so the guard isn't passing by refusing
// everything.
func TestYouCanSearchYourOwnOrganization(t *testing.T) {
	mine := &domain.ClaimsJWT{
		UserID: "u-ana",
		Orgs:   []domain.OrgMembershipClaim{{OrgID: "org-1", Role: "member"}},
	}

	rec := httptest.NewRecorder()
	h := &userHandler{}
	// No service wired: reaching past the authorization check is what is being
	// asserted, and a nil service panics rather than answering 403 — so a plain
	// "not 403" is the signal.
	defer func() { recover() }()
	h.Search(rec, searchReq("org-1", mine))
	if rec.Code == http.StatusForbidden {
		t.Error("your own organization must not be refused")
	}
}
