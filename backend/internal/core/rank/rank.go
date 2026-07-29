// Package rank implements fractional indexing: string keys that can always be
// ordered lexicographically, with a new key derivable *between* any two others.
//
// Why not an integer `position`: moving one card in a board would renumber every
// card after it (N writes, and two people dragging at once corrupt the order).
// With fractional ranks a move is a single-row update and concurrent moves at
// worst end up adjacent, never scrambled.
package rank

import "strings"

// digits is the ordered alphabet. ASCII order matches this order, so plain
// string comparison sorts correctly.
const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const (
	// First is the rank handed to the first item in an empty container.
	First = "U" // mid-alphabet, leaving room on both sides
	minD  = '0'
	maxD  = 'z'
)

func indexOf(c byte) int { return strings.IndexByte(digits, c) }

// Between returns a rank that sorts strictly after `a` and strictly before `b`.
// Empty strings mean "no bound": Between("", x) yields a rank before x, and
// Between(x, "") one after x.
func Between(a, b string) string {
	switch {
	case a == "" && b == "":
		return First
	case a == "":
		return before(b)
	case b == "":
		return after(a)
	}
	if a >= b {
		// Callers shouldn't invert bounds; degrade to "just after a" rather than
		// returning something that breaks ordering.
		return after(a)
	}
	return midpoint(a, b)
}

// midpoint walks both keys digit by digit, and as soon as there's room between
// them emits the middle digit; otherwise it copies and keeps descending.
func midpoint(a, b string) string {
	var out strings.Builder
	for i := 0; ; i++ {
		ca := byte(minD)
		if i < len(a) {
			ca = a[i]
		}
		cb := byte(maxD) + 1 // exclusive upper bound when b runs out
		if i < len(b) {
			cb = b[i]
		}

		if ca == cb {
			out.WriteByte(ca)
			continue
		}

		ia, ib := indexOf(ca), indexOf(cb)
		if ib < 0 { // b exhausted: anything above ca works
			ib = len(digits)
		}
		if ib-ia > 1 {
			out.WriteByte(digits[(ia+ib)/2])
			return out.String()
		}
		// Digits are adjacent: keep a's digit and append a digit that lands
		// after whatever remains of a.
		out.WriteByte(ca)
		return out.String() + after(sliceFrom(a, i+1))
	}
}

func sliceFrom(s string, i int) string {
	if i >= len(s) {
		return ""
	}
	return s[i:]
}

// after returns a rank strictly greater than a.
func after(a string) string {
	if a == "" {
		return First
	}
	// Bump the last digit when possible; otherwise extend the key.
	last := a[len(a)-1]
	if i := indexOf(last); i >= 0 && i < len(digits)-1 {
		// Land midway between the last digit and the top so there's still room.
		return a[:len(a)-1] + string(digits[(i+len(digits))/2])
	}
	return a + First
}

// before returns a rank strictly smaller than b.
//
// A key must never end in the smallest digit: "00" would leave nothing below it
// ("00X" sorts *after* "00", since a prefix always sorts first). So when there's
// no room left in a digit we descend into the "0" bucket and place the new key
// inside it instead.
func before(b string) string {
	if b == "" {
		return First
	}
	i := indexOf(b[0])
	switch {
	case i > 1:
		return string(digits[i/2]) // plenty of room below this digit
	case i == 1:
		return string(digits[0]) + First // "0U" < "1", and doesn't end in '0'
	default:
		// b already starts at the smallest digit: stay in that bucket.
		return string(digits[0]) + before(b[1:])
	}
}
