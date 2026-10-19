package domain

import "testing"

// Una referencia es a un ítem (`op://`) o a la variable de un Environment de
// 1Password (`op-env://`), y nunca un valor. Mutantes: aceptar sólo `op://`;
// aceptar un `op-env://` sin variable o con un valor pegado.
func TestValidSecretRef(t *testing.T) {
	for _, c := range []struct {
		ref string
		ok  bool
	}{
		{"op://dwit/Web RRHH/DATABASE_URL", true},
		{"op-env://RRHH prod/DATABASE_URL", true},
		{"op-env://RRHH dev/NEXT_PUBLIC_APP_URL", true},
		{"op-env://RRHH prod/", false},
		{"op-env:///DATABASE_URL", false},
		{"op-env://RRHH prod/DATABASE_URL=postgres://x", false},
		{"op-env://RRHH prod/a/b", false},
		{"postgres://user:pass@host/db", false},
		{"", false},
	} {
		if got := ValidSecretRef(c.ref); got != c.ok {
			t.Errorf("ValidSecretRef(%q) = %v, se esperaba %v", c.ref, got, c.ok)
		}
	}
}
