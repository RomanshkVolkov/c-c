package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// waitFor polls until cond holds or the deadline passes. Delivery happens on
// its own goroutine, so the test can't just assert straight after the call.
func waitFor(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

func target(url, secret string) *domain.ReportEventTarget {
	return &domain.ReportEventTarget{
		OrgID: "org-1", ProjectID: "proj-1", Folio: "demo-7",
		ReporterID: "user-ana", ReporterName: "Ana",
		WebhookURL: url, WebhookSecret: secret,
	}
}

// Every event has to name the reporter. Without it a receiver can't answer
// "who do I notify?" — the comment event only carries a comment id — and would
// need either a local report → user index or a callback to cac just to send a
// notification. This is what keeps that machinery out of the receiving app.
func TestEveryEventNamesTheReporter(t *testing.T) {
	var bodies [][]byte
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
	}))
	defer srv.Close()

	s := &ReportService{}
	events := []string{"report:new", "report:status", "report:comment", "report:attachment"}
	for _, ev := range events {
		s.dispatchWebhook(target(srv.URL, ""), ev, "rep-1", nil)
	}
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(bodies) == len(events)
	})

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != len(events) {
		t.Fatalf("got %d deliveries, want %d", len(bodies), len(events))
	}
	for _, b := range bodies {
		var p webhookPayload
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatalf("bad payload: %v", err)
		}
		if p.ReporterID != "user-ana" {
			t.Errorf("%s carries reporterId %q, want the filer's id", p.Type, p.ReporterID)
		}
		if p.ReporterName != "Ana" {
			t.Errorf("%s carries reporterName %q", p.Type, p.ReporterName)
		}
	}
}

func TestReceiverCanVerifyTheSignatureOverTheExactBytes(t *testing.T) {
	const secret = "a-secret-at-least-16-chars"
	var gotSig, gotEvent string
	var gotBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotSig = r.Header.Get("X-Cac-Signature")
		gotEvent = r.Header.Get("X-Cac-Event")
	}))
	defer srv.Close()

	s := &ReportService{}
	s.dispatchWebhook(target(srv.URL, secret), "report:status", "rep-1",
		map[string]any{"status": "done"})

	if !waitFor(t, 2*time.Second, func() bool { return gotSig != "" }) {
		t.Fatal("webhook never arrived")
	}

	// Verified the way a receiver must: over the raw bytes, before parsing.
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(gotBody)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if gotSig != want {
		t.Errorf("signature does not verify over the received body\n got %s\nwant %s", gotSig, want)
	}
	if gotEvent != "report:status" {
		t.Errorf("X-Cac-Event = %q", gotEvent)
	}

	var p webhookPayload
	if err := json.Unmarshal(gotBody, &p); err != nil {
		t.Fatalf("body is not the documented payload: %v", err)
	}
	if p.Type != "report:status" || p.ReportID != "rep-1" || p.ProjectID != "proj-1" || p.Folio != "demo-7" {
		t.Errorf("payload fields wrong: %+v", p)
	}
	if p.Data["status"] != "done" {
		t.Errorf("data not carried through: %+v", p.Data)
	}
	if p.At.IsZero() {
		t.Error("payload should carry a timestamp")
	}
}

// A tampered body must not verify — otherwise the signature buys nothing.
func TestATamperedBodyDoesNotVerify(t *testing.T) {
	const secret = "a-secret-at-least-16-chars"
	body := []byte(`{"type":"report:new"}`)
	sig := signPayload(secret, body)
	if sig == signPayload(secret, append(body, ' ')) {
		t.Error("a changed body produced the same signature")
	}
	if sig == signPayload("another-secret-16chars", body) {
		t.Error("a different secret produced the same signature")
	}
}

func TestNoSecretMeansNoSignatureHeader(t *testing.T) {
	var had atomic.Bool
	var arrived atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		had.Store(r.Header.Get("X-Cac-Signature") != "")
		arrived.Store(true)
	}))
	defer srv.Close()

	s := &ReportService{}
	s.dispatchWebhook(target(srv.URL, ""), "report:new", "rep-1", nil)
	if !waitFor(t, 2*time.Second, arrived.Load) {
		t.Fatal("webhook never arrived")
	}
	if had.Load() {
		t.Error("no secret configured, so nothing should be signed")
	}
}

// A 5xx is the receiver being briefly broken; a 4xx is it rejecting this exact
// request. Retrying the first is useful, retrying the second is noise.
func TestRetriesServerErrorsButNotRejections(t *testing.T) {
	var fiveHundreds, fourHundreds atomic.Int32

	srvFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fiveHundreds.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srvFail.Close()
	srvReject := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fourHundreds.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srvReject.Close()

	s := &ReportService{}
	s.dispatchWebhook(target(srvFail.URL, ""), "report:new", "r", nil)
	s.dispatchWebhook(target(srvReject.URL, ""), "report:new", "r", nil)

	waitFor(t, 12*time.Second, func() bool { return fiveHundreds.Load() >= int32(webhookAttempts) })
	if got := fiveHundreds.Load(); got != int32(webhookAttempts) {
		t.Errorf("5xx: tried %d times, want %d", got, webhookAttempts)
	}
	if got := fourHundreds.Load(); got != 1 {
		t.Errorf("4xx: tried %d times, want 1 (no point repeating a rejection)", got)
	}
}

// A project with no webhook must cost nothing — no goroutine, no request.
func TestNoEndpointMeansNoRequest(t *testing.T) {
	var hit atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit.Store(true) }))
	defer srv.Close()

	s := &ReportService{}
	s.dispatchWebhook(target("", "secret-at-least-16-chars"), "report:new", "r", nil)
	s.dispatchWebhook(nil, "report:new", "r", nil)
	time.Sleep(200 * time.Millisecond)
	if hit.Load() {
		t.Error("a project without a webhook must not generate traffic")
	}
}

// The bug this whole feature nearly shipped with: report:new used to publish
// straight to the hub, so anything hung off emit() would have covered four of
// the five events and silently skipped the one a subscriber most wants.
func TestEveryReportEventGoesThroughEmit(t *testing.T) {
	path := filepath.Join("report.go")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	code := string(src)

	if strings.Contains(code, `hub.Publish(events.Event{Type: "report:new"`) {
		t.Error(`report:new publishes straight to the hub again — it must go through emit(), ` +
			`or webhooks (and anything else added there) will miss it`)
	}
	for _, ev := range []string{"report:new", "report:status", "report:comment", "report:attachment"} {
		if !strings.Contains(code, `s.emit("`+ev+`"`) {
			t.Errorf("%s is not emitted through emit()", ev)
		}
	}
}
