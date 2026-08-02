package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

func projectWith(origins ...string) *domain.ReportProject {
	return &domain.ReportProject{Platform: "web", AllowedOrigins: domain.StringList(origins)}
}

func check(t *testing.T, p *domain.ReportProject, origin string) (bool, int) {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/ingest/v1/reports", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	return allowedOrigin(rec, r, p), rec.Code
}

// The rule the field label already promises: nothing registered, nothing
// enforced. This is what a native app relies on — it sends no Origin at all.
func TestEmptyAllowlistAllowsAnything(t *testing.T) {
	for _, origin := range []string{"", "https://anything.example", "null"} {
		if ok, _ := check(t, projectWith(), origin); !ok {
			t.Errorf("empty allowlist rejected Origin %q", origin)
		}
	}
}

// The regression this exists for. A widget's ingest key is printed inside the
// JavaScript the browser downloads, so it is readable by anyone who visits the
// page. The allowlist used to be skipped entirely when no Origin header was
// present, which is every curl — so the registered origins guarded browsers
// and nobody else, and a copied key worked fine from a script.
func TestARegisteredAllowlistIsNotOptional(t *testing.T) {
	p := projectWith("https://app.cliente.mx")

	ok, code := check(t, p, "")
	if ok {
		t.Error("a request with no Origin passed a project that has origins registered")
	}
	if code != http.StatusForbidden {
		t.Errorf("no-Origin → %d, want 403", code)
	}

	if ok, code := check(t, p, "https://evil.example"); ok || code != http.StatusForbidden {
		t.Errorf("foreign Origin → allowed=%v code=%d, want refused with 403", ok, code)
	}

	if ok, _ := check(t, p, "https://app.cliente.mx"); !ok {
		t.Error("the registered origin was refused")
	}
}

// A native project has no browser and no Origin to send, so the rule does not
// apply to it at all. Origins left over on one must stay inert: the console
// hides the field for "app", and a rule nobody can see is a rule nobody can
// fix — it would take portento's ingest down at the next deploy with a 403
// pointing at a list that isn't on screen.
func TestANativeProjectIsExemptEvenWithOriginsLeftOver(t *testing.T) {
	p := projectWith("https://app.cliente.mx")
	p.Platform = "app"
	for _, origin := range []string{"", "https://anywhere.example"} {
		if ok, _ := check(t, p, origin); !ok {
			t.Errorf("native project refused Origin %q", origin)
		}
	}
}

// Matching is exact. A prefix or suffix match would let evil-cliente.mx and
// app.cliente.mx.attacker.com through, which is the usual way this check is
// gotten wrong.
func TestOriginMatchingIsExact(t *testing.T) {
	p := projectWith("https://app.cliente.mx")
	for _, origin := range []string{
		"https://app.cliente.mx.attacker.example",
		"https://evil-app.cliente.mx",
		"http://app.cliente.mx", // scheme matters
		"https://app.cliente.mx/",
		"https://app.cliente.mx:8443",
	} {
		if ok, _ := check(t, p, origin); ok {
			t.Errorf("Origin %q was accepted against https://app.cliente.mx", origin)
		}
	}
}

// "Sent none" and "sent one that isn't listed" need different error codes: the
// caller can't see the list, so a single "Origin not allowed" for both sends
// whoever integrates this looking for a typo that isn't there.
func TestTheTwoRefusalsAreDistinguishable(t *testing.T) {
	p := projectWith("https://app.cliente.mx")
	r1 := httptest.NewRequest(http.MethodPost, "/x", nil)
	rec1 := httptest.NewRecorder()
	allowedOrigin(rec1, r1, p)

	r2 := httptest.NewRequest(http.MethodPost, "/x", nil)
	r2.Header.Set("Origin", "https://evil.example")
	rec2 := httptest.NewRecorder()
	allowedOrigin(rec2, r2, p)

	if rec1.Body.String() == rec2.Body.String() {
		t.Errorf("both refusals answer the same body: %s", rec1.Body.String())
	}
}
