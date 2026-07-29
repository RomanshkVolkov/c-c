package handler

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

func TestKeyFromBucketURL(t *testing.T) {
	cases := map[string]string{
		"https://guz-reports-media.s3.mx-central-1.amazonaws.com/tasks/abc/file.png": "tasks/abc/file.png",
		"https://b.s3.us-east-1.amazonaws.com/x.webp":                                "x.webp",
		"/api/v1/tasks/1/attachments/2/raw":                                          "",
		"":                                                                           "",
	}
	for in, want := range cases {
		if got := keyFromBucketURL(in); got != want {
			t.Errorf("keyFromBucketURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAttachmentRef(t *testing.T) {
	if got := domain.AttachmentRef("t1", "a1"); got != "/api/v1/tasks/t1/attachments/a1/raw" {
		t.Fatalf("unexpected path: %q", got)
	}
}

// A pre-proxy row (bucket URL, no key) must come back pointing at the proxy.
func TestNormalizeURL(t *testing.T) {
	a := domain.TaskAttachment{TaskID: "t1", URL: "https://b.s3.mx-central-1.amazonaws.com/tasks/t1/p.png"}
	a.ID = "a1"
	a.NormalizeURL()
	if a.URL != "/api/v1/tasks/t1/attachments/a1/raw" {
		t.Fatalf("not normalized: %q", a.URL)
	}
	already := domain.TaskAttachment{TaskID: "t1", URL: "/api/v1/tasks/t1/attachments/a1/raw"}
	already.NormalizeURL()
	if already.URL != "/api/v1/tasks/t1/attachments/a1/raw" {
		t.Fatalf("rewrote an already-proxied URL: %q", already.URL)
	}
}
