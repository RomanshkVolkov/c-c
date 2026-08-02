package handler

import "testing"

// One noisy reporter must not spend the project's whole hourly budget. The
// project ceiling alone can't express that: it is one counter, so whoever gets
// there first locks out everybody else — and the people locked out are exactly
// the ones with something to report.
func TestOneReporterCannotLockOutTheRest(t *testing.T) {
	l := newIngestLimiter()
	const project, perProject, perReporter = "p1", 20, 3

	accepted := 0
	for i := 0; i < 10; i++ {
		if l.allow(project, perProject) && l.allow(project+"/noisy", perReporter) {
			accepted++
		}
	}
	if accepted != perReporter {
		t.Errorf("the noisy reporter got %d reports through, want %d", accepted, perReporter)
	}

	// And someone else still gets in, which is the whole point.
	if !l.allow(project, perProject) || !l.allow(project+"/quiet", perReporter) {
		t.Error("a second reporter was blocked by the first one's noise")
	}
}

// The project ceiling still applies: per-person limits must not add up past it.
func TestTheProjectCeilingStillHolds(t *testing.T) {
	l := newIngestLimiter()
	const perProject, perReporter = 5, 3

	accepted := 0
	for r := 0; r < 4; r++ { // four reporters, 3 each = 12 attempts
		name := string(rune('a' + r))
		for i := 0; i < 3; i++ {
			if l.allow("p1", perProject) && l.allow("p1/"+name, perReporter) {
				accepted++
			}
		}
	}
	if accepted > perProject {
		t.Errorf("%d reports got through a ceiling of %d", accepted, perProject)
	}
}

// Zero disables the per-person cap, which is what a project with anonymous
// reporters needs — there is no identity to count against.
func TestZeroDisablesThePerPersonCap(t *testing.T) {
	// The handler skips the call entirely at 0; this pins the contract that a
	// project configured that way is governed by its ceiling alone.
	l := newIngestLimiter()
	for i := 0; i < 20; i++ {
		if !l.allow("p1", 20) {
			t.Fatalf("the project ceiling refused report %d of 20", i+1)
		}
	}
	if l.allow("p1", 20) {
		t.Error("the ceiling did not stop the 21st")
	}
}
