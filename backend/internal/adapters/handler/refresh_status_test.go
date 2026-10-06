package handler

import (
	"errors"
	"fmt"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// La app cierra la sesión ante un 401 del refresh. Desde que el refresh pasa
// por la base, un fallo del servidor no puede contestarse con 401 o un hipo de
// Postgres echaría a todo el mundo. Mutante: tratar todo error como 401.
func TestOnlyAnInvalidRefreshIsA401(t *testing.T) {
	for _, err := range []error{
		repository.ErrRefreshRevoked,
		fmt.Errorf("canje: %w", repository.ErrRefreshRevoked),
		errors.New("expired-token"),
		errors.New("user not found"),
	} {
		if !isRefreshAuthFailure(err) {
			t.Errorf("%v tiene que ser 401", err)
		}
	}
	if isRefreshAuthFailure(errors.New("dial tcp: connection refused")) {
		t.Error("un fallo de la base no es un refresh inválido")
	}
}
