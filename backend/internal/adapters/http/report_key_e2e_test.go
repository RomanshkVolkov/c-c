package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	adapterhttp "github.com/guz-studio/cac/backend/internal/adapters/http"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// The property the whole project-key design rests on, checked against a real
// Postgres and the real router: two projects live in the SAME organization, so
// anything that authorizes by org membership passes both. Only "this report is
// mine" separates them.
//
// Skips when there is no database to talk to, so `go test ./...` stays green on
// a machine without one.
func TestProjectKeyCannotSeeTheNeighbouringProject(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "E2E Org", Slug: "e2e-org"}
	org.ID = "org-e2e"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}

	keyA, keyB := "pk_e2e_alpha_key", "pk_e2e_beta_key"
	projA := mkProject(t, db, "proj-a", "alpha", org.ID, keyA)
	projB := mkProject(t, db, "proj-b", "beta", org.ID, keyB)
	repA := mkReport(t, db, "rep-a", projA.ID, "alpha bug")
	repB := mkReport(t, db, "rep-b", projB.ID, "beta bug")

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	do := func(method, path, key string) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		req.Header.Set("X-Ingest-Key", key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var buf [1 << 16]byte
		n, _ := resp.Body.Read(buf[:])
		resp.Body.Close()
		return resp, buf[:n]
	}

	// The list shows exactly one report — its own — even though both projects
	// belong to the same organization.
	resp, body := do(http.MethodGet, "/api/v1/reports/", keyA)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list → %d: %s", resp.StatusCode, body)
	}
	var list struct {
		Data struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Data.Items) != 1 || list.Data.Items[0].ID != repA.ID {
		t.Errorf("list with alpha's key = %+v, want only %s", list.Data.Items, repA.ID)
	}

	// Asking for the neighbour by id answers an empty list. It must not answer
	// alpha's own reports: silently substituting data the caller did not ask
	// for is what merely *forcing* q.ProjectID does, and it reads as a
	// successful query for the wrong project.
	_, body = do(http.MethodGet, "/api/v1/reports/?projectId="+projB.ID, keyA)
	json.Unmarshal(body, &list)
	if len(list.Data.Items) != 0 {
		t.Errorf("?projectId=beta with alpha's key returned %d items, want 0", len(list.Data.Items))
	}

	// Reading and triaging the neighbour's report answers 404, not 403: a 403
	// would confirm the id exists.
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/reports/" + repB.ID},
		{http.MethodPatch, "/api/v1/reports/" + repB.ID},
	} {
		if resp, body := do(c.method, c.path, keyA); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s neighbour → %d, want 404: %s", c.method, resp.StatusCode, body)
		}
	}

	// And its own report is reachable, or the test above proves nothing.
	if resp, body := do(http.MethodGet, "/api/v1/reports/"+repA.ID, keyA); resp.StatusCode != http.StatusOK {
		t.Errorf("own report → %d, want 200: %s", resp.StatusCode, body)
	}
	_ = repB
}

// A tenant's reply has two audiences that need opposite things, and only one of
// them is visible while testing from the app.
//
// In cac the thread must name who answered — "portento", not a blank byline.
// For the reporter it must read as "team": never as their own words, and
// without exposing which tenant is behind the board. And it has to raise the
// unread badge, which used to key off author_user_id alone and so would have
// silently skipped every reply a project key wrote.
func TestATenantReplyIsNamedInCacAndAnonymousToTheReporter(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "E2E Org", Slug: "e2e-org"}
	org.ID = "org-e2e"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	const key = "pk_e2e_reply_key"
	proj := mkProject(t, db, "proj-r", "portento", org.ID, key)
	rep := mkReport(t, db, "rep-r", proj.ID, "something broke")
	before := time.Now().Add(-time.Minute)

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	// The tenant replies with its project key.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("body", "we shipped a fix")
	mw.WriteField("authorName", "José")
	mw.WriteField("authorId", "42")
	mw.Close()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/reports/"+rep.ID+"/comments", &buf)
	req.Header.Set("X-Ingest-Key", key)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("tenant reply → %d: %s", resp.StatusCode, body)
	}

	// Side one: cac names the tenant.
	var detail struct {
		Data struct {
			Comments []struct {
				Author *struct {
					Kind        string `json:"kind"`
					Name        string `json:"name"`
					ProjectName string `json:"projectName"`
					ExternalID  string `json:"externalId"`
				} `json:"author"`
				AuthorName  string `json:"authorName"`
				AuthorLabel string `json:"authorLabel"`
				Body        string `json:"body"`
			} `json:"comments"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Data.Comments) != 1 {
		t.Fatalf("got %d comments, want 1", len(detail.Data.Comments))
	}
	c := detail.Data.Comments[0]
	if c.Author == nil {
		t.Fatalf("the comment came back with no author: %s", body)
	}
	if c.Author.Kind != "tenant" {
		t.Errorf("author kind = %q, want \"tenant\"", c.Author.Kind)
	}
	// Both halves: who wrote it, and which tenant vouches for that name. The
	// name alone would let a tenant sending "admin" pass for the cac user.
	if c.Author.Name != "José" {
		t.Errorf("author name = %q, want the person the tenant named", c.Author.Name)
	}
	if c.Author.ProjectName != proj.Name {
		t.Errorf("author projectName = %q, want %q", c.Author.ProjectName, proj.Name)
	}
	if c.Author.ExternalID != "42" {
		t.Errorf("author externalId = %q, want the tenant's own user id", c.Author.ExternalID)
	}
	// The installed app predates `author` and reads these; dropping them blanks
	// out every tenant byline until everyone updates.
	if c.AuthorLabel != proj.Name {
		t.Errorf("flat authorLabel = %q, want %q for older builds", c.AuthorLabel, proj.Name)
	}

	// Side two: the reporter sees a reply from "team", not from themselves, and
	// is told nothing about which tenant wrote it.
	tok := repository.MintReportToken(rep.ID)
	resp, err = http.Get(srv.URL + "/ingest/v1/reports/" + rep.ID + "?token=" + tok)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reporter view → %d: %s", resp.StatusCode, body)
	}
	var view struct {
		Data struct {
			Comments []struct {
				Author     string `json:"author"`
				AuthorName string `json:"authorName"`
				Body       string `json:"body"`
			} `json:"comments"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Data.Comments) != 1 {
		t.Fatalf("reporter sees %d comments, want 1", len(view.Data.Comments))
	}
	if got := view.Data.Comments[0].Author; got != "team" {
		t.Errorf("reporter sees author %q, want \"team\" (\"you\" would show them their own words as a reply)", got)
	}
	// The discriminator stays a closed union for the published widget, and the
	// name rides alongside it — that is the whole reason for the second field.
	if got := view.Data.Comments[0].AuthorName; got != "José" {
		t.Errorf("reporter sees authorName %q, want the person who answered", got)
	}
	// The folio legitimately carries the project slug — it is the reporter's own
	// ticket number. What must not appear is the tenant's display name, which is
	// the label cac signs the reply with internally.
	if strings.Contains(string(body), proj.Name) {
		t.Errorf("the reporter payload names the tenant %q: %s", proj.Name, body)
	}

	// And the badge fires, which is what tells the reporter to come back.
	n, err := repository.NewReportRepository(db).CountTeamCommentsSince(rep.ID, before)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("unread count = %d, want 1 — a tenant reply must raise the badge", n)
	}
}

// A tenant tidies its own replies and nothing else. Checked over HTTP against a
// real database because the rule spans three layers — the middleware decides the
// endpoint exists, the handler picks the project path, and the service owns the
// actual comparison — and a mistake in any one of them reads as success here.
func TestATenantEditsItsOwnReplyButNotAPersons(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "E2E Org", Slug: "e2e-org"}
	org.ID = "org-e2e"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	const key = "pk_e2e_own_key"
	proj := mkProject(t, db, "proj-o", "portento", org.ID, key)
	rep := mkReport(t, db, "rep-o", proj.ID, "broken")

	// One comment from a person on cac's side, one from the tenant.
	human := "u-someone"
	mine := &domain.ReportComment{ReportID: rep.ID, Kind: domain.CommentKindUser, AuthorProjectID: &proj.ID, Body: "ours"}
	mine.ID = "c-tenant"
	theirs := &domain.ReportComment{ReportID: rep.ID, Kind: domain.CommentKindUser, AuthorUserID: &human, Body: "theirs"}
	theirs.ID = "c-human"
	if err := db.Create(mine).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(theirs).Error; err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	send := func(method, path, payload string) int {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(payload))
		req.Header.Set("X-Ingest-Key", key)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	base := "/api/v1/reports/" + rep.ID + "/comments/"
	if code := send(http.MethodPatch, base+mine.ID, `{"body":"corrected"}`); code != http.StatusOK {
		t.Errorf("editing its own reply → %d, want 200", code)
	}
	if code := send(http.MethodPatch, base+theirs.ID, `{"body":"hijacked"}`); code == http.StatusOK {
		t.Error("the tenant rewrote a person's comment")
	}
	if code := send(http.MethodDelete, base+theirs.ID, ""); code == http.StatusOK {
		t.Error("the tenant deleted a person's comment")
	}
	// Removing a whole report is a different thing from tidying a reply, and
	// stays shut at the middleware.
	if code := send(http.MethodDelete, "/api/v1/reports/"+rep.ID, ""); code != http.StatusForbidden {
		t.Errorf("deleting the report → %d, want 403", code)
	}

	// A fresh destination per lookup: GORM folds a non-zero primary key on the
	// destination into the query, so reusing one silently ANDs the previous id
	// into the next WHERE and finds nothing.
	body := func(id string) string {
		t.Helper()
		var c domain.ReportComment
		if err := db.Where("id = ?", id).First(&c).Error; err != nil {
			t.Fatalf("comment %s is gone: %v", id, err)
		}
		return c.Body
	}

	// Refusing the request is not enough — the row itself must be untouched.
	if got := body(theirs.ID); got != "theirs" {
		t.Errorf("the person's comment now reads %q", got)
	}
	if got := body(mine.ID); got != "corrected" {
		t.Errorf("the tenant's own edit did not persist, body is %q", got)
	}
}

// A cac user's identity comes from their token, so a comment they post must be
// signed with their own name even if the request says otherwise. Reading
// authorName for them would not be a feature, it would be an impersonation
// endpoint — and the same field is legitimate for a project key, which is
// exactly the kind of asymmetry that gets lost in a refactor.
func TestAPersonCannotRenameThemselvesOnAComment(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "E2E Org", Slug: "e2e-org"}
	org.ID = "org-e2e"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	user := &domain.User{Username: "realname", Email: "u@example.com", Password: "x"}
	user.ID = "user-e2e"
	if err := db.Create(user).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.OrgMembership{
		OrgID: org.ID, UserID: user.ID, Role: domain.OrgRoleAdmin,
	}).Error; err != nil {
		t.Fatal(err)
	}
	proj := mkProject(t, db, "proj-p", "portento", org.ID, "pk_e2e_person")
	rep := mkReport(t, db, "rep-p", proj.ID, "broken")

	pair, err := repository.GenerateTokens(user.ID, user.Username, false,
		[]domain.OrgMembershipClaim{{OrgID: org.ID, Role: domain.OrgRoleAdmin}})
	if err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("body", "on it")
	mw.WriteField("authorName", "somebody else")
	mw.Close()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/reports/"+rep.ID+"/comments", &buf)
	req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("person reply → %d: %s", resp.StatusCode, body)
	}

	var detail struct {
		Data struct {
			Comments []struct {
				Author *struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
				} `json:"author"`
			} `json:"comments"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Data.Comments) != 1 || detail.Data.Comments[0].Author == nil {
		t.Fatalf("unexpected thread: %s", body)
	}
	a := detail.Data.Comments[0].Author
	if a.Kind != "user" {
		t.Errorf("author kind = %q, want \"user\"", a.Kind)
	}
	if a.Name != user.Username {
		t.Errorf("author name = %q, want %q — the request must not rename the caller", a.Name, user.Username)
	}

	// And the two things the console's new pencil and bin actually call. This
	// path existed before any UI reached it, so it had never been exercised
	// end to end.
	var thread struct {
		Data struct {
			Comments []struct {
				ID   string `json:"id"`
				Body string `json:"body"`
			} `json:"comments"`
		} `json:"data"`
	}
	json.Unmarshal(body, &thread)
	commentID := thread.Data.Comments[0].ID

	send := func(method, payload string) int {
		t.Helper()
		req, _ := http.NewRequest(method,
			srv.URL+"/api/v1/reports/"+rep.ID+"/comments/"+commentID, strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if code := send(http.MethodPatch, `{"body":"on it, fixed"}`); code != http.StatusOK {
		t.Errorf("editing own comment → %d, want 200", code)
	}
	var after domain.ReportComment
	if err := db.Where("id = ?", commentID).First(&after).Error; err != nil {
		t.Fatal(err)
	}
	if after.Body != "on it, fixed" {
		t.Errorf("the edit did not persist, body is %q", after.Body)
	}

	if code := send(http.MethodDelete, ""); code != http.StatusOK {
		t.Errorf("deleting own comment → %d, want 200", code)
	}
	// Soft delete: gone from the thread, still on disk.
	var live int64
	db.Model(&domain.ReportComment{}).Where("id = ?", commentID).Count(&live)
	if live != 0 {
		t.Error("the comment is still in the thread after being deleted")
	}
	var kept int64
	db.Unscoped().Model(&domain.ReportComment{}).Where("id = ?", commentID).Count(&kept)
	if kept != 1 {
		t.Error("the row was destroyed; deletes here are meant to be recoverable")
	}
}

// The reporter's own comments must carry their name. The report has held
// reporterName since it was filed, so rendering the literal word "reporter" over
// a thread of messages from a named person discards something already known —
// and it is what the console actually showed.
func TestTheReporterIsNamedOnTheirOwnComments(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "E2E Org", Slug: "e2e-org"}
	org.ID = "org-e2e"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	proj := mkProject(t, db, "proj-n", "portento", org.ID, "pk_e2e_named")
	rep := mkReport(t, db, "rep-n", proj.ID, "broken")
	// mkReport files it as "u1"; give it a human name like a real widget does.
	if err := db.Model(rep).Update("reporter_name", "Romanshk Volkov").Error; err != nil {
		t.Fatal(err)
	}
	c := &domain.ReportComment{ReportID: rep.ID, Kind: domain.CommentKindUser, Body: "muchas gracias"}
	c.ID = "c-reporter"
	if err := db.Create(c).Error; err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/reports/"+rep.ID, nil)
	req.Header.Set("X-Ingest-Key", "pk_e2e_named")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	var detail struct {
		Data struct {
			Comments []struct {
				Author *struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
				} `json:"author"`
				AuthorName string `json:"authorName"`
			} `json:"comments"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Data.Comments) != 1 || detail.Data.Comments[0].Author == nil {
		t.Fatalf("unexpected thread: %s", body)
	}
	got := detail.Data.Comments[0]
	if got.Author.Kind != "reporter" {
		t.Errorf("author kind = %q, want \"reporter\"", got.Author.Kind)
	}
	if got.Author.Name != "Romanshk Volkov" {
		t.Errorf("author name = %q, want the reporter's name", got.Author.Name)
	}
	// The flat field too, or a build that predates `author` keeps printing the
	// placeholder.
	if got.AuthorName != "Romanshk Volkov" {
		t.Errorf("flat authorName = %q, want the reporter's name for older builds", got.AuthorName)
	}
}

// ─── harness ──────────────────────────────────────────────────────────────────

func e2eDB(t *testing.T) (*gorm.DB, func()) {
	t.Helper()
	loadEnvQuietly("../../../.env")
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
		repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
		repository.GetEnv("DB_NAME", "cac"), repository.GetEnv("DB_SSLMODE", "disable"))

	admin, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	const name = "cac_e2e_projkey"
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	sqlDB, _ := admin.DB()

	tmpDSN := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
		repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
		name, repository.GetEnv("DB_SSLMODE", "disable"))
	db, err := gorm.Open(postgres.Open(tmpDSN), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&domain.Organization{}, &domain.User{}, &domain.OrgMembership{},
		&domain.ReportProject{}, &domain.Report{}, &domain.ReportComment{}, &domain.ReportImage{}); err != nil {
		t.Fatal(err)
	}
	// The ingest key HMAC is keyed by an env secret; pin one so the hashes this
	// test writes match what the middleware computes.
	if os.Getenv("INGEST_KEY_SECRET") == "" {
		os.Setenv("INGEST_KEY_SECRET", "e2e-fixed-secret")
	}
	return db, func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		sqlDB.Close()
	}
}

// loadEnvQuietly reads the .env by path. repository.LoadEnv opens "./.env"
// relative to the working directory, which under `go test` is this package's
// directory, not the module root.
func loadEnvQuietly(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if _, set := os.LookupEnv(strings.TrimSpace(k)); !set {
			os.Setenv(strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"`))
		}
	}
}

func mkProject(t *testing.T, db *gorm.DB, id, slug, orgID, key string) *domain.ReportProject {
	t.Helper()
	// Display name deliberately unlike the slug: the folio the reporter sees is
	// built from the slug, so a test that searched for the slug would flag the
	// ticket number as a leak.
	p := &domain.ReportProject{
		OrgID: orgID, Name: strings.ToUpper(slug) + " Support", Slug: slug, Platform: "app",
		IngestKeyHash: repository.HashIngestKey(key), IsActive: true,
	}
	p.ID = id
	if err := db.Create(p).Error; err != nil {
		t.Fatal(err)
	}
	return p
}

func mkReport(t *testing.T, db *gorm.DB, id, projectID, title string) *domain.Report {
	t.Helper()
	rep := &domain.Report{
		ProjectID: projectID, Title: title, Description: title,
		Status: domain.ReportPending, ReporterID: "u1", ReporterName: "u1",
	}
	rep.ID = id
	if err := db.Create(rep).Error; err != nil {
		t.Fatal(err)
	}
	return rep
}
