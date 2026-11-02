package domain

import "testing"

// Un área se escribe de muchas formas y tiene que ser una sola, o lo que la
// busca después no la encuentra. Roturas que atrapa: no quitar acentos; no
// pasar espacios y guiones bajos a guiones; no pasar a minúsculas.
func TestAnAreaIsOneWordHoweverItIsWritten(t *testing.T) {
	for in, want := range map[string]string{
		"Cert Manager":   "cert-manager",
		"CERT_MANAGER":   "cert-manager",
		" cert-manager ": "cert-manager",
		"Configuración":  "configuracion",
		"k8s":            "k8s",
		"--":             "",
	} {
		if got := NormalizeIncidentArea(in); got != want {
			t.Errorf("%q → %q, se esperaba %q", in, got, want)
		}
	}
	if _, sha, ok := ParseCommitRef("RomanshkVolkov/c-c@5397E32"); !ok || sha != "5397e32" {
		t.Errorf("owner/repo@sha: %q %v", sha, ok)
	}
	for _, bad := range []string{"main", "abc12", "5397e32 extra"} {
		if _, _, ok := ParseCommitRef(bad); ok {
			t.Errorf("%q se tomó por un commit", bad)
		}
	}
}
