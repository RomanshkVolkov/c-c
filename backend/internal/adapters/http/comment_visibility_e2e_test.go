package http_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	adapterhttp "github.com/guz-studio/cac/backend/internal/adapters/http"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// An internal note must not leave cac by any door.
//
// This is the one filter in the codebase whose failure is a leak rather than a
// bug: the team writes something frank about a client's report, and the client
// reads it. Everywhere else a wrong answer is embarrassing; here it is a breach
// of the thing the feature exists to protect.
//
// So it is checked at every exit at once — the tenant's API, the reporter's
// view, and the unread badge that would otherwise announce a message they can
// never open. Checking one and trusting the rest is how the third one gets
// forgotten.
func TestAnInternalNoteNeverLeavesCac(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "Vis Org", Slug: "vis-org"}
	org.ID = "org-vis"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	// A real author: a comment with no author at all reads as the reporter's own,
	// and the unread badge quite rightly doesn't count those.
	author := &domain.User{Username: "ana", Email: "ana@vis.test", Password: "x"}
	author.ID = "u-vis"
	if err := db.Create(author).Error; err != nil {
		t.Fatal(err)
	}

	const key = "pk_visibility_key"
	proj := mkProject(t, db, "proj-vis", "vis", org.ID, key)
	rep := mkReport(t, db, "rep-vis", proj.ID, "algo que discutir")
	since := time.Now().Add(-time.Minute)

	// One of each, both from the team.
	pub := &domain.ReportComment{
		ItemID: rep.ID, Kind: domain.CommentKindUser,
		Visibility: domain.VisibilityPublic, Body: "estamos en ello",
	}
	pub.ID = "cmt-public"
	pub.AuthorUserID = &author.ID
	internal := &domain.ReportComment{
		ItemID: rep.ID, Kind: domain.CommentKindUser,
		Visibility: domain.VisibilityInternal, Body: "SECRETO: el cliente insiste otra vez",
	}
	internal.ID = "cmt-internal"
	internal.AuthorUserID = &author.ID
	for _, c := range []*domain.ReportComment{pub, internal} {
		if err := db.Create(c).Error; err != nil {
			t.Fatal(err)
		}
	}

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	body := func(req *http.Request) string {
		t.Helper()
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s %s → %d: %s", req.Method, req.URL.Path, resp.StatusCode, b)
		}
		return string(b)
	}

	// ── Door one: the tenant's own API, with its project key.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/reports/"+rep.ID, nil)
	req.Header.Set("X-Ingest-Key", key)
	tenant := body(req)
	if !strings.Contains(tenant, "estamos en ello") {
		t.Error("the tenant should still receive the public reply")
	}
	if strings.Contains(tenant, "SECRETO") {
		t.Error("the tenant received an internal note")
	}

	// ── Door two: the reporter, with their per-report token.
	tok := repository.MintReportToken(rep.ID)
	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/ingest/v1/reports/"+rep.ID+"?token="+tok, nil)
	reporter := body(req)
	if !strings.Contains(reporter, "estamos en ello") {
		t.Error("the reporter should still receive the public reply")
	}
	if strings.Contains(reporter, "SECRETO") {
		t.Error("the reporter received an internal note")
	}

	// ── Door three: the count on the tenant's list. "5 comments", open it, see 2
	// is a leak of metadata and a visible bug at the same time.
	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/api/v1/reports/", nil)
	req.Header.Set("X-Ingest-Key", key)
	var list struct {
		Data struct {
			Items []struct {
				CommentCount int64 `json:"commentCount"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body(req)), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Data.Items) != 1 {
		t.Fatalf("expected the one report, got %d", len(list.Data.Items))
	}
	if got := list.Data.Items[0].CommentCount; got != 1 {
		t.Errorf("the tenant should be told about one comment, not %d", got)
	}

	// ── Door four: the reporter's unread badge, which would announce a message
	// they can never open.
	repo := repository.NewReportRepository(db)
	n, err := repo.CountTeamCommentsSince(rep.ID, since)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("unread should count only the public reply, got %d", n)
	}
}
