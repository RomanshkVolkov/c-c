package domain

import "testing"

// The bridge an installed app walks across.
//
// The desktop client is updated by hand, so builds from weeks ago are still
// asking for the board the same way: read `statuses`, remember a `statusId`, send
// it back to move a card. The configurable columns behind those ids are gone, so
// the ids are derived now — and an id that doesn't survive the round trip means a
// board where nothing can be dragged anywhere.

func TestAStatusIDSurvivesTheRoundTrip(t *testing.T) {
	for _, want := range []ReportStatus{ReportPending, ReportInProgress, ReportResolved, ReportClosed} {
		id := SyntheticStatusID("list-1", want)
		got, ok := SplitSyntheticStatusID(id)
		if !ok {
			t.Fatalf("%s: the id we just made didn't parse back", want)
		}
		if got != want {
			t.Errorf("%s round-tripped to %s", want, got)
		}
	}
}

// Two boards must never trade ids: a card dropped on one list's column would
// otherwise be accepted by the other.
func TestColumnsOfDifferentListsHaveDifferentIDs(t *testing.T) {
	a := BoardStatuses("list-a")
	b := BoardStatuses("list-b")
	for i := range a {
		if a[i].ID == b[i].ID {
			t.Errorf("column %q shares an id between two lists: %s", a[i].Name, a[i].ID)
		}
	}
}

// A client that learned the new vocabulary shouldn't have to fabricate a list
// prefix just to name a state.
func TestABareStateNameIsAccepted(t *testing.T) {
	for _, in := range []string{"pending", "in_progress", "resolved", "closed", "open", "done"} {
		if _, ok := SplitSyntheticStatusID(in); !ok {
			t.Errorf("%q should be accepted on its own", in)
		}
	}
}

// And nonsense must be refused rather than silently landing a card somewhere.
func TestAnUnknownStatusIDIsRefused(t *testing.T) {
	for _, in := range []string{"", "list-1/", "list-1/nope", "garbage", "list-1/PENDING "} {
		if s, ok := SplitSyntheticStatusID(in); ok {
			t.Errorf("%q was accepted as %q", in, s)
		}
	}
}

// Every state a board can show has to be a column, or a card lands somewhere the
// UI has nowhere to draw and disappears from the board.
func TestEveryStateHasAColumn(t *testing.T) {
	cols := BoardStatuses("list-1")
	for state := range ReportTransitions() {
		found := false
		for _, c := range cols {
			if got, _ := SplitSyntheticStatusID(c.ID); got == state {
				found = true
			}
		}
		if !found {
			t.Errorf("no column for %q — a card in that state would vanish from the board", state)
		}
	}
}

// "Finished" is read off the kind, never off the name. That is the whole reason
// kind existed: renaming a column was always allowed.
func TestFinishedIsDecidedByKindNotName(t *testing.T) {
	if !IsFinished(ReportResolved) {
		t.Error("resolved is finished")
	}
	if !IsFinished(ReportClosed) {
		t.Error("closed is finished too — a report can be closed without being fixed, but it is off the board")
	}
	if IsFinished(ReportPending) || IsFinished(ReportInProgress) {
		t.Error("pending and in_progress are open work")
	}
	// The legacy spellings fold before the question is asked.
	if !IsFinished("done") {
		t.Error("the old vocabulary has to fold first: `done` is resolved")
	}
	if IsFinished("open") {
		t.Error("`open` is pending, which is not finished")
	}
}

// The two priority scales were one scale with two names for the middle rung.
func TestPriorityFoldsBetweenTheTwoScales(t *testing.T) {
	if ItemPriority("normal").Canonical() != ItemPriorityMedium {
		t.Error("`normal` and `medium` were always the same rung")
	}
	// What an older task client is answered with, so its labels still match.
	if got := ItemPriorityMedium.TaskWire(); got != "normal" {
		t.Errorf("the task API has always said `normal`; got %q", got)
	}
	// The report contract has four values and no "undecided" column.
	if got := ItemPriorityNone.ReportWire(); got != ItemPriorityMedium {
		t.Errorf("a tenant has no column for `none`; got %q", got)
	}
	// Everything else passes through untouched, both ways.
	for _, p := range []ItemPriority{ItemPriorityLow, ItemPriorityHigh, ItemPriorityUrgent} {
		if p.TaskWire() != p || p.ReportWire() != p {
			t.Errorf("%q should not be rewritten by either side", p)
		}
	}
}

func TestAnUnknownPriorityIsRejected(t *testing.T) {
	for _, p := range []ItemPriority{"", "critical", "MEDIUM", "blocker"} {
		if p.IsValid() {
			t.Errorf("%q should not be a valid priority", p)
		}
	}
	for _, p := range append(ItemPriorities(), "normal") {
		if !p.IsValid() {
			t.Errorf("%q should be valid", p)
		}
	}
}

func TestVisibilityIsOnlyTheTwoValues(t *testing.T) {
	if !VisibilityInternal.IsValid() || !VisibilityPublic.IsValid() {
		t.Fatal("both real values must validate")
	}
	for _, v := range []ItemVisibility{"", "private", "PUBLIC", "team"} {
		if v.IsValid() {
			t.Errorf("%q must not pass as a visibility — a wrong one here is a leak", v)
		}
	}
}
