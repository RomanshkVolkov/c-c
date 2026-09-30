package domain

import "testing"

// Lo que se puede desplegar en un servicio: su repositorio y una referencia
// segura, nada más. Es la primera puerta; el agente lo vuelve a comprobar.
func TestAnImageRefStaysInItsRepository(t *testing.T) {
	const repo = "ghcr.io/dwit-mexico/api"
	digest := "@sha256:" + "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2"
	casos := []struct {
		image string
		ok    bool
	}{
		{repo + ":abc1234", true},
		{repo + ":latest", true},
		{repo + ":abc1234" + digest, true},
		{"ghcr.io/otro/api:abc1234", false},
		{repo + "-evil:abc1234", false},
		{repo + ":abc; rm -rf /", false},
		{repo + ":--mount", false},
		{repo + ":", false},
		{repo + ":abc1234@sha256:corto", false},
		{repo, false},
	}
	for _, c := range casos {
		if _, ok := ImageRef(repo, c.image); ok != c.ok {
			t.Errorf("%q → %v, se esperaba %v", c.image, ok, c.ok)
		}
	}
}

// Un deploy se pide de un commit.
func TestADeployIsOfACommit(t *testing.T) {
	for _, s := range []string{"abc1234", "0123456789abcdef0123456789abcdef01234567"} {
		if !ValidSha(s) {
			t.Errorf("%q es un sha", s)
		}
	}
	for _, s := range []string{"abc123", "ABC1234", "latest", "abc1234; ls", "--mount", "0123456789abcdef0123456789abcdef012345678"} {
		if ValidSha(s) {
			t.Errorf("%q no es un sha", s)
		}
	}
}
