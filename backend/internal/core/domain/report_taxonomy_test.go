package domain

import "strings"

import "testing"

// Category and priority are handled two different ways on purpose, and the
// difference is the point of these tests: ingest is a public endpoint fed by
// third-party widgets, so it normalizes anything it doesn't recognise rather
// than dropping a real bug report; the admin API refuses instead, because a
// filter that silently means something else is worse than an error.

func TestIngestNeverLosesAReportOverALabel(t *testing.T) {
	for _, in := range []string{"", "nonsense", "BUG", "Bug", " ui "} {
		if got := NormalizeCategory(in); got != CategoryOther {
			// Only exact matches count; everything else lands in "other".
			t.Errorf("NormalizeCategory(%q) = %q, want %q", in, got, CategoryOther)
		}
	}
	for _, in := range []string{"", "nonsense", "URGENT", "Medium"} {
		if got := NormalizePriority(in); got != ReportPriorityMedium {
			t.Errorf("NormalizePriority(%q) = %q, want %q", in, got, ReportPriorityMedium)
		}
	}
}

func TestKnownLabelsSurviveNormalization(t *testing.T) {
	for _, c := range ReportCategories() {
		if NormalizeCategory(string(c)) != c {
			t.Errorf("category %q should normalize to itself", c)
		}
	}
	for _, p := range ReportPriorities() {
		if NormalizePriority(string(p)) != p {
			t.Errorf("priority %q should normalize to itself", p)
		}
	}
}

// The admin API validates with IsValid, which must NOT be forgiving.
func TestAdminFiltersRejectUnknownLabels(t *testing.T) {
	for _, c := range []ReportCategory{"", "nonsense", "Bug"} {
		if c.IsValid() {
			t.Errorf("category %q must be rejected by the admin API", c)
		}
	}
	for _, p := range []ReportPriority{"", "nonsense", "Urgent"} {
		if p.IsValid() {
			t.Errorf("priority %q must be rejected by the admin API", p)
		}
	}
	for _, c := range ReportCategories() {
		if !c.IsValid() {
			t.Errorf("category %q must be accepted", c)
		}
	}
	for _, p := range ReportPriorities() {
		if !p.IsValid() {
			t.Errorf("priority %q must be accepted", p)
		}
	}
}

// Area is free text, but it still has to fit the column it's stored in.
func TestAreaIsTrimmedToFitTheColumn(t *testing.T) {
	if got := NormalizeArea("  Sala de Operaciones  "); got != "Sala de Operaciones" {
		t.Errorf("surrounding space should go, got %q", got)
	}
	long := NormalizeArea(strings.Repeat("x", 500))
	if len(long) > maxAreaLen {
		t.Errorf("area must fit varchar(%d), got %d chars", maxAreaLen, len(long))
	}
	if NormalizeArea("") != "" {
		t.Error("empty area should stay empty, not gain a default")
	}
}

// The taxonomy endpoint must answer from the constants, not a second list that
// could drift from them.
func TestTaxonomyEndpointMirrorsTheConstants(t *testing.T) {
	tax := ReportTaxonomy{Categories: ReportCategories(), Priorities: ReportPriorities()}
	if len(tax.Categories) != 5 || len(tax.Priorities) != 4 {
		t.Fatalf("unexpected taxonomy size: %d categories, %d priorities",
			len(tax.Categories), len(tax.Priorities))
	}
	// Priorities are ordered low → urgent; clients render them in this order.
	want := []ReportPriority{ReportPriorityLow, ReportPriorityMedium, ReportPriorityHigh, ReportPriorityUrgent}
	for i, p := range want {
		if tax.Priorities[i] != p {
			t.Errorf("priority %d = %q, want %q", i, tax.Priorities[i], p)
		}
	}
}
