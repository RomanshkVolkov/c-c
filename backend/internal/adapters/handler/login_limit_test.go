package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
El límite de login (barrido, 6-oct-2026). Contaba sólo por usuario, así que
probar una contraseña contra muchas cuentas no se frenaba nunca. Ahora cuenta
también por IP —la que añade nuestro Gateway, no la que dice el cliente—, y un
login bueno no limpia la de la IP.
*/

func loginDesde(h *authHandler, ip, usuario string) int {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(fmt.Sprintf(`{"username":%q,"password":"incorrecta-123"}`, usuario)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forwarded-For", "6.6.6.6, "+ip)
	rec := httptest.NewRecorder()
	h.Login(rec, r)
	return rec.Code
}

// Mutantes: no contar por IP; tomar el primer valor de X-Forwarded-For (el que
// escribe el cliente); dejar de contar por usuario.
func TestOneIPCannotSprayPasswordsAcrossAccounts(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := &authHandler{authService: service.NewAuthService(repository.NewAuthRepository(db)), limiter: newLoginLimiter()}

	for i := 0; i < loginMaxFailuresPerIP; i++ {
		if code := loginDesde(h, "1.2.3.4", fmt.Sprintf("cuenta-%d", i)); code != http.StatusUnauthorized {
			t.Fatalf("intento %d → %d", i, code)
		}
	}
	if code := loginDesde(h, "1.2.3.4", "otra-cuenta"); code != http.StatusTooManyRequests {
		t.Errorf("la misma IP con otra cuenta → %d, se esperaba 429", code)
	}
	if code := loginDesde(h, "5.6.7.8", "otra-cuenta"); code != http.StatusUnauthorized {
		t.Errorf("otra IP → %d, no debería estar frenada", code)
	}

	for i := 0; i < loginMaxFailures; i++ {
		loginDesde(h, fmt.Sprintf("10.0.0.%d", i), "una-sola")
	}
	if code := loginDesde(h, "10.0.1.1", "una-sola"); code != http.StatusTooManyRequests {
		t.Errorf("una cuenta desde muchas IPs → %d, se esperaba 429", code)
	}
}

// Los usuarios inventados no se quedan para siempre en memoria. Mutante: no
// barrer.
func TestTheLimiterForgetsOldFailures(t *testing.T) {
	l := newLoginLimiter()
	viejo := time.Now().Add(-2 * loginWindow)
	for i := 0; i <= loginSweepAt; i++ {
		l.failures[fmt.Sprintf("k-%d", i)] = []time.Time{viejo}
	}
	l.fail("nuevo")
	if n := len(l.failures); n != 1 {
		t.Errorf("quedan %d claves, se esperaba sólo la nueva", n)
	}
}
