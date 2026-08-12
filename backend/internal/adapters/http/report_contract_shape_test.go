package http_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	adapterhttp "github.com/guz-studio/cac/backend/internal/adapters/http"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
)

// The *shape* of what a tenant receives, pinned key by key.
//
// The tests next door prove behaviour — who may read what, who owns a comment,
// what the reporter is called. This one proves the envelope: exactly these
// fields, spelt exactly this way. A rewrite that drops `folio`, renames
// `reporterId`, or nests something one level deeper passes every behavioural
// test and still breaks portento, whose client reads these names.
//
// It exists because the report tables are about to be replaced by a unified
// item model. The whole promise of that work is that this file keeps passing.
//
// Written as "these keys must be present" rather than "only these keys": adding
// a field is how the API has always grown (`author` beside `authorLabel`,
// `token` on the reporter view), and it doesn't break a reader. Removing or
// renaming one does.

func TestTheReportListAndDetailKeepTheirShape(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "Shape Org", Slug: "shape-org"}
	org.ID = "org-shape"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	const key = "pk_shape_key"
	proj := mkProject(t, db, "proj-shape", "shape", org.ID, key)
	rep := mkReport(t, db, "rep-shape", proj.ID, "a bug with a shape")
	// A number of its own: the factory next door inserts straight to the table
	// and leaves seq at zero. What's pinned here is the *spelling* of the folio,
	// slug-then-number, not how the number was chosen.
	if err := db.Model(rep).Update("seq", 7).Error; err != nil {
		t.Fatal(err)
	}

	// A comment and an image, so their shapes are pinned too — the empty case
	// would prove nothing about the fields inside them.
	c := &domain.ReportComment{ReportID: rep.ID, Body: "una respuesta", Kind: domain.CommentKindUser}
	c.ID = "cmt-shape"
	c.AuthorProjectID = &proj.ID
	c.AuthorExternalID = "u-other"
	c.AuthorExternalName = "Alguien del tenant"
	if err := db.Create(c).Error; err != nil {
		t.Fatal(err)
	}
	img := &domain.ReportImage{ReportID: rep.ID, Path: "shape/one.png", FileName: "one.png"}
	img.ID = "img-shape"
	if err := db.Create(img).Error; err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	get := func(path string) map[string]any {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.Header.Set("X-Ingest-Key", key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, resp.StatusCode, body)
		}
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatalf("GET %s: %v (%s)", path, err, body)
		}
		// The envelope itself is contract: portento's readEnvelope reads these two.
		mustHave(t, "envelope of "+path, envelope, "success", "data")
		data, ok := envelope["data"].(map[string]any)
		if !ok {
			t.Fatalf("GET %s: data is not an object: %T", path, envelope["data"])
		}
		return data
	}

	// ── The list ──────────────────────────────────────────────────────────────
	list := get("/api/v1/reports/")
	mustHave(t, "list", list, "items", "total", "limit", "offset")
	items, _ := list["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected the project's one report, got %d", len(items))
	}
	item, _ := items[0].(map[string]any)
	mustHave(t, "list item", item,
		"id", "folio", "projectId", "projectName", "projectSlug", "seq",
		"title", "status", "category", "priority", "origin",
		"reporterName", "createdAt", "updatedAt", "commentCount", "imageCount")

	if got := item["folio"]; got != "shape-7" {
		t.Errorf("folio is the public name of the report: want shape-7, got %v", got)
	}

	// ── The detail ────────────────────────────────────────────────────────────
	detail := get("/api/v1/reports/" + rep.ID)
	mustHave(t, "detail", detail,
		"id", "folio", "projectId", "projectSlug", "seq",
		"title", "description", "status", "category", "priority", "area", "origin",
		"url", "userAgent", "viewport", "reporterName", "reporterId",
		"createdAt", "updatedAt", "images", "comments")

	imgs, _ := detail["images"].([]any)
	if len(imgs) != 1 {
		t.Fatalf("expected one image, got %d", len(imgs))
	}
	one, _ := imgs[0].(map[string]any)
	mustHave(t, "image", one, "id", "url", "fileName")
	// The URL is signed and short-lived: an <img> in a browser can't send a
	// credential, so the signature is what stands in for one. A rewrite that
	// served a bare path here would 401 every thumbnail in portento.
	if u, _ := one["url"].(string); !strings.Contains(u, "exp=") || !strings.Contains(u, "sig=") {
		t.Errorf("image url must carry its signature, got %q", u)
	}

	comments, _ := detail["comments"].([]any)
	if len(comments) != 1 {
		t.Fatalf("expected one comment, got %d", len(comments))
	}
	cm, _ := comments[0].(map[string]any)
	mustHave(t, "comment", cm, "id", "kind", "body", "createdAt", "author")
	author, _ := cm["author"].(map[string]any)
	mustHave(t, "comment author", author, "kind", "name")
	if author["kind"] != "tenant" {
		t.Errorf("a reply posted with the project key is a tenant reply, got %v", author["kind"])
	}
	// authorLabel is still emitted for builds that predate `author`. It stays
	// until nothing old is deployed; dropping it early blanks the byline.
	mustHave(t, "comment", cm, "authorLabel")
}

// The taxonomy and the state machine are served rather than copied, precisely so
// a client can't drift from them — which makes their shape contract too.
func TestTransitionsAndTaxonomyKeepTheirShape(t *testing.T) {
	db, cleanup := e2eDB(t)
	defer cleanup()

	org := &domain.Organization{Name: "Shape Org 2", Slug: "shape-org-2"}
	org.ID = "org-shape-2"
	if err := db.Create(org).Error; err != nil {
		t.Fatal(err)
	}
	const key = "pk_shape_meta_key"
	mkProject(t, db, "proj-shape-2", "shapetwo", org.ID, key)

	r := chi.NewRouter()
	adapterhttp.InitReportRoutes(db, r, events.NewHub())
	srv := httptest.NewServer(r)
	defer srv.Close()

	data := func(path string) map[string]any {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.Header.Set("X-Ingest-Key", key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatalf("GET %s: %v (%s)", path, err, body)
		}
		out, _ := envelope["data"].(map[string]any)
		return out
	}

	tr := data("/api/v1/reports/transitions")
	// Every state a client can be shown must be a key here, or the board has a
	// column it can never move a card out of.
	for _, s := range []string{"pending", "in_progress", "resolved", "closed"} {
		if _, ok := tr[s]; !ok {
			t.Errorf("transitions is missing %q — a board would strand cards there", s)
		}
	}

	tax := data("/api/v1/reports/taxonomy")
	mustHave(t, "taxonomy", tax, "categories", "priorities")
	prios, _ := tax["priorities"].([]any)
	// Ordered low → urgent, and clients render them in this order. The unified
	// model adds `none` internally; this endpoint must keep offering exactly the
	// four a tenant knows how to display.
	want := []string{"low", "medium", "high", "urgent"}
	if len(prios) != len(want) {
		t.Fatalf("priorities: want %v, got %v", want, prios)
	}
	for i, w := range want {
		if prios[i] != w {
			t.Errorf("priorities[%d]: want %q, got %v", i, w, prios[i])
		}
	}
}

func mustHave(t *testing.T, what string, obj map[string]any, keys ...string) {
	t.Helper()
	var missing []string
	for _, k := range keys {
		if _, ok := obj[k]; !ok {
			missing = append(missing, k)
		}
	}
	if len(missing) == 0 {
		return
	}
	have := make([]string, 0, len(obj))
	for k := range obj {
		have = append(have, k)
	}
	sort.Strings(have)
	t.Errorf("%s is missing %v — a reader of this field breaks.\n  present: %v", what, missing, have)
}
