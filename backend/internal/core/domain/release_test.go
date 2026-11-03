package domain

import (
	"testing"
	"time"
)

// Roturas que atrapa: dar por salida una tarea sin commits, o una con alguno
// fuera (`<=` por `<`), o quedarse con la primera release en vez de la más
// reciente (la que dejó todo fuera).
func TestShippedOfNeedsEveryCommitOut(t *testing.T) {
	day := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	a := ReleaseRef{Tag: "v1.0.0", At: day}
	b := ReleaseRef{Tag: "v1.1.0", At: day.Add(48 * time.Hour)}
	c := ReleaseRef{Tag: "v1.0.1", At: day.Add(24 * time.Hour)}
	if ShippedOf(0, nil) != nil {
		t.Error("sin commits, nada puede haber salido")
	}
	if ShippedOf(3, []ReleaseRef{a, b}) != nil {
		t.Error("con un commit fuera, la tarea no salió")
	}
	if got := ShippedOf(3, []ReleaseRef{a, b, c}); got == nil || got.Tag != "v1.1.0" {
		t.Errorf("salió entera en la más reciente, no en %+v", got)
	}
}
