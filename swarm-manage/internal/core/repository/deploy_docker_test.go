package repository

import "testing"

// El `:` de un puerto de registro no es un tag.
func TestSplitTag(t *testing.T) {
	casos := map[string][2]string{
		"ghcr.io/a/b:abc1234":             {"ghcr.io/a/b", "abc1234"},
		"registry:5000/a/b:v1":            {"registry:5000/a/b", "v1"},
		"registry:5000/a/b":               {"registry:5000/a/b", "latest"},
		"ghcr.io/a/b:v1@sha256:" + "ab12": {"ghcr.io/a/b", "v1"},
	}
	for in, want := range casos {
		if n, tag := splitTag(in); n != want[0] || tag != want[1] {
			t.Errorf("%q → (%q, %q), se esperaba %v", in, n, tag, want)
		}
	}
}
