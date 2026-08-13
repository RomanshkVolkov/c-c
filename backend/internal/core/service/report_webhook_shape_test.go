package service

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"
)

// The webhook payload, pinned key by key.
//
// The tests next door prove the signature, the retries, and that no event
// forgets the reporter. This one pins the *envelope*, because a receiver reads
// these names off the JSON: portento's route destructures `type`, `reportId`,
// `folio` and `data.from`. Rename or drop one and its notifications go quiet
// with a 200 on both sides — nothing fails, it just stops working.
//
// It exists because the report tables are about to become a unified item model,
// and the payload has to survive that byte-for-byte.

func TestTheWebhookPayloadKeepsItsShape(t *testing.T) {
	var got []byte
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		close(done)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dispatchWebhook(target(srv.URL, "s3cret"), "report:comment", "rep-1", map[string]any{
		"reportId":  "rep-1",
		"commentId": "cmt-1",
		"from":      "team",
	})

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the webhook never arrived")
	}

	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("payload is not JSON: %v (%s)", err, got)
	}

	// Every one of these is read by a receiver. `reporterId` and `reporterName`
	// are what let it answer "who do I notify" without keeping its own index.
	needs(t, "payload", payload,
		"type", "reportId", "projectId", "folio", "reporterId", "reporterName", "data", "at")

	if payload["type"] != "report:comment" {
		t.Errorf("type: want report:comment, got %v", payload["type"])
	}
	if payload["folio"] != "demo-7" {
		t.Errorf("folio: want demo-7, got %v", payload["folio"])
	}

	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("data must be an object, got %T", payload["data"])
	}
	// `from` is the echo filter: without it a tenant notifies itself for every
	// reply it just posted. It travels inside `data`, same as on the live stream,
	// so a receiver can treat both the same way.
	needs(t, "data", data, "from", "reportId", "commentId")
	if data["from"] != "team" {
		t.Errorf("data.from: want team, got %v", data["from"])
	}

	// `at` is parseable UTC, not a formatting accident.
	at, _ := payload["at"].(string)
	if _, err := time.Parse(time.RFC3339, at); err != nil {
		t.Errorf("at must be an RFC3339 timestamp, got %q", at)
	}
}

// The headers are the other half of the envelope: a receiver switches on
// X-Cac-Event before parsing anything, and verifies X-Cac-Signature over the
// raw bytes.
func TestTheWebhookHeadersKeepTheirNames(t *testing.T) {
	var event, sig, contentType string
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		event = r.Header.Get("X-Cac-Event")
		sig = r.Header.Get("X-Cac-Signature")
		contentType = r.Header.Get("Content-Type")
		close(done)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dispatchWebhook(target(srv.URL, "s3cret"), "report:status", "rep-1", map[string]any{
		"reportId": "rep-1", "status": "in_progress", "from": "team",
	})

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the webhook never arrived")
	}

	if event != "report:status" {
		t.Errorf("X-Cac-Event: want report:status, got %q", event)
	}
	if contentType != "application/json" {
		t.Errorf("Content-Type: want application/json, got %q", contentType)
	}
	// The `sha256=` prefix is part of what a receiver compares against; dropping
	// it makes every signature mismatch.
	if len(sig) < 8 || sig[:7] != "sha256=" {
		t.Errorf("X-Cac-Signature must be sha256=<hex>, got %q", sig)
	}
}

func needs(t *testing.T, what string, obj map[string]any, keys ...string) {
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
	t.Errorf("%s is missing %v — a receiver reading that field breaks.\n  present: %v", what, missing, have)
}
