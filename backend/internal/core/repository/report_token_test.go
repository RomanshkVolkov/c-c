package repository

import (
	"os"
	"strconv"
	"testing"
	"time"
)

// The per-report token is what lets someone follow up on a bug they filed
// without an account. If it expires while they're still using it, they lose
// access to their own report and nothing tells them why — so renewal has to
// happen while they're around to receive the replacement, and only then.

func TestMain(m *testing.M) {
	os.Setenv("REPORT_TOKEN_SECRET", "test-secret-for-report-tokens")
	os.Exit(m.Run())
}

func TestAFreshTokenIsValidAndNotYetWorthRenewing(t *testing.T) {
	tok := MintReportToken("rep-1")

	if !VerifyReportToken("rep-1", tok) {
		t.Fatal("a token just minted should verify")
	}
	exp, ok := ReportTokenExpiry("rep-1", tok)
	if !ok {
		t.Fatal("expiry should be readable from a valid token")
	}
	if left := time.Until(exp); left < 89*24*time.Hour {
		t.Errorf("expected ~90 days of life, got %v", left)
	}
	if RenewReportTokenIfStale("rep-1", tok) != "" {
		t.Error("a token with its full life ahead must not be replaced — that would mint a new one on every page load")
	}
}

func TestATokenNearingExpiryIsReplaced(t *testing.T) {
	// Signed by hand at a chosen expiry: the only way to reach the window
	// without waiting two months.
	exp := time.Now().Add(10 * 24 * time.Hour).Unix()
	old := formatToken(exp, signReportToken("rep-2", exp))

	if !VerifyReportToken("rep-2", old) {
		t.Fatal("still valid: it hasn't expired yet")
	}
	fresh := RenewReportTokenIfStale("rep-2", old)
	if fresh == "" {
		t.Fatal("a token 10 days from expiry is inside the renewal window")
	}
	if fresh == old {
		t.Fatal("the replacement must be a different token")
	}
	if !VerifyReportToken("rep-2", fresh) {
		t.Fatal("the replacement has to work")
	}
	// And the old one keeps working until it actually dies: a client that
	// ignores the new one isn't locked out mid-session.
	if !VerifyReportToken("rep-2", old) {
		t.Error("renewing must not invalidate the token still in the client's hands")
	}
}

func TestAnExpiredOrForgedTokenIsRefusedAndNeverRenewed(t *testing.T) {
	dead := time.Now().Add(-time.Hour).Unix()
	expired := formatToken(dead, signReportToken("rep-3", dead))

	for name, tok := range map[string]string{
		"expired":       expired,
		"bad signature": formatToken(time.Now().Add(time.Hour).Unix(), "deadbeef"),
		"no separator":  "not-a-token",
		"empty":         "",
	} {
		if VerifyReportToken("rep-3", tok) {
			t.Errorf("%s: must not verify", name)
		}
		if RenewReportTokenIfStale("rep-3", tok) != "" {
			t.Errorf("%s: must never be handed a replacement — that would be a free pass", name)
		}
	}
}

func TestATokenIsBoundToItsOwnReport(t *testing.T) {
	tok := MintReportToken("rep-mine")
	if VerifyReportToken("rep-someone-elses", tok) {
		t.Fatal("a token for one report must not open another — this is what keeps reports from being enumerable")
	}
}

// The wire format: "<expUnix>.<hexsig>".
func formatToken(exp int64, sig string) string {
	return strconv.FormatInt(exp, 10) + "." + sig
}
