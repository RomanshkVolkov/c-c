package repository

import (
	"slices"
	"testing"
)

// En el clúster el backend no arranca con un secreto vacío o de ejemplo: con
// `JWT_SECRET_ACCESS` vacío cualquiera firmaría tokens. Mutantes: aceptar el
// valor de ejemplo; olvidar uno de la lista.
func TestMissingSecrets(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "change-me-please")
	t.Setenv("JWT_SECRET_REFRESH", "")
	t.Setenv("INGEST_KEY_SECRET", "de-verdad")
	got := MissingSecrets()
	if !slices.Equal(got, []string{"JWT_SECRET_ACCESS", "JWT_SECRET_REFRESH"}) {
		t.Errorf("faltan %v", got)
	}
	t.Setenv("JWT_SECRET_ACCESS", "x")
	t.Setenv("JWT_SECRET_REFRESH", "y")
	t.Setenv("INGEST_KEY_SECRET", "")
	if got := MissingSecrets(); !slices.Equal(got, []string{"INGEST_KEY_SECRET"}) {
		t.Errorf("faltan %v", got)
	}
}
