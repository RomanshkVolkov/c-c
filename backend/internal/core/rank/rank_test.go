package rank

import (
	"sort"
	"testing"
)

func TestBetweenOrders(t *testing.T) {
	cases := []struct{ a, b string }{
		{"", ""},
		{"", "U"},
		{"U", ""},
		{"U", "V"},
		{"A", "z"},
	}
	for _, c := range cases {
		got := Between(c.a, c.b)
		if c.a != "" && got <= c.a {
			t.Fatalf("Between(%q,%q)=%q not after a", c.a, c.b, got)
		}
		if c.b != "" && got >= c.b {
			t.Fatalf("Between(%q,%q)=%q not before b", c.a, c.b, got)
		}
	}
}

// The pathological case for fractional indexing: repeatedly inserting between
// the same two neighbours must keep working (this is where float-based ranks
// run out of precision).
func TestRepeatedMidpointStaysOrdered(t *testing.T) {
	lo, hi := "U", "V"
	prev := lo
	for i := 0; i < 200; i++ {
		mid := Between(prev, hi)
		if mid <= prev || mid >= hi {
			t.Fatalf("iteration %d: %q not strictly between %q and %q", i, mid, prev, hi)
		}
		prev = mid
	}
}

// Appending to the end many times must stay sorted.
func TestAppendSequence(t *testing.T) {
	var ranks []string
	last := ""
	for i := 0; i < 500; i++ {
		last = Between(last, "")
		ranks = append(ranks, last)
	}
	if !sort.StringsAreSorted(ranks) {
		t.Fatal("appended ranks are not lexicographically sorted")
	}
}

// Prepending to the front many times must stay sorted.
func TestPrependSequence(t *testing.T) {
	var ranks []string
	first := ""
	for i := 0; i < 200; i++ {
		first = Between("", first)
		ranks = append([]string{first}, ranks...)
	}
	if !sort.StringsAreSorted(ranks) {
		t.Fatal("prepended ranks are not lexicographically sorted")
	}
}
