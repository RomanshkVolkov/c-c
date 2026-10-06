package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// El mismo vector que `TestAgentSessionVector` del backend
// (`backend/internal/core/repository/agent_token_test.go`). El backend firma
// y el agente verifica con dos copias del algoritmo en dos módulos: si una
// cambia, la app deja de poder hablarle a ningún agente, y sólo un vector
// compartido lo ve. Si cambias éste, cambia aquél.
func TestSessionVector(t *testing.T) {
	const (
		key    = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
		server = "srv-1"
		token  = "dS1hbmE.1900000000.c2495462c61f43dcdf008bbf99ee63daceab9c7badc9c3c33169d905dfc10ea5"
	)
	u, ok := VerifySession(key, server, token, time.Unix(1900000000-60, 0))
	if !ok || u != "u-ana" {
		t.Fatalf("el pase del vector no verifica: %q %v", u, ok)
	}
}

func sign(key, server, user string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(key))
	fmt.Fprintf(mac, "agent-session:%s:%s:%d", server, user, exp)
	return fmt.Sprintf("%s.%d.%s", base64.RawURLEncoding.EncodeToString([]byte(user)), exp, hex.EncodeToString(mac.Sum(nil)))
}

func TestASessionOpensOnlyItsServerUntilItExpires(t *testing.T) {
	exp := time.Now().Add(time.Minute)
	tok := sign("k", "srv-1", "u-ana", exp.Unix())
	if _, ok := VerifySession("k", "srv-1", tok, time.Now()); !ok {
		t.Fatal("el pase bueno no abre")
	}
	if _, ok := VerifySession("k", "srv-2", tok, time.Now()); ok {
		t.Error("un pase de srv-1 abre srv-2")
	}
	if _, ok := VerifySession("otra", "srv-1", tok, time.Now()); ok {
		t.Error("un pase firmado con otra llave abre")
	}
	if _, ok := VerifySession("k", "srv-1", tok, exp.Add(time.Second)); ok {
		t.Error("un pase caducado abre")
	}
}

func servir(key, server string, req *http.Request) int {
	h := RequireSession(key, server)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

// El pase por la URL, sólo para leer: es lo que necesita el `EventSource` de
// los logs, y nada que cambie algo puede aceptarlo por ahí, porque la URL
// acaba en los logs de cualquier proxy del camino.
func TestTheURLPassIsOnlyForReading(t *testing.T) {
	tok := sign("k", "srv-1", "u-ana|w", time.Now().Add(time.Minute).Unix())
	get := httptest.NewRequest(http.MethodGet, "/api/v1/services/x/logs?access_token="+tok, nil)
	if code := servir("k", "srv-1", get); code != http.StatusOK {
		t.Errorf("GET con el pase en la URL → %d, se esperaba 200", code)
	}
	post := httptest.NewRequest(http.MethodPost, "/api/v1/services/x/force-update?access_token="+tok, nil)
	if code := servir("k", "srv-1", post); code != http.StatusUnauthorized {
		t.Errorf("POST con el pase en la URL → %d, se esperaba 401", code)
	}
	head := httptest.NewRequest(http.MethodPost, "/api/v1/services/x/force-update", nil)
	head.Header.Set("Authorization", "Bearer "+tok)
	if code := servir("k", "srv-1", head); code != http.StatusOK {
		t.Errorf("POST con el pase en la cabecera → %d, se esperaba 200", code)
	}
}

// Sin llave no hay modo abierto: 503 a todo, con o sin pase.
func TestWithoutAKeyTheAPIStaysShut(t *testing.T) {
	tok := sign("", "srv-1", "u-ana", time.Now().Add(time.Minute).Unix())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if code := servir("", "srv-1", req); code != http.StatusServiceUnavailable {
		t.Errorf("sin llave → %d, se esperaba 503", code)
	}
	if code := servir("k", "", req); code != http.StatusServiceUnavailable {
		t.Errorf("sin id de servidor → %d, se esperaba 503", code)
	}
}

// El mismo vector que `TestAgentSubjectVector` del backend: el rol va al final
// del sujeto firmado. Si cambia uno, cambia el otro.
func TestSessionRoleVector(t *testing.T) {
	cases := map[string]struct {
		user  string
		write bool
	}{
		"u-ana|w":   {"u-ana", true},
		"u-ana|r":   {"u-ana", false},
		"u-ana":     {"u-ana", false},
		"u|ana|w":   {"u|ana", true},
		"u-ana|w|r": {"u-ana|w", false},
	}
	for subject, want := range cases {
		if u, w := SessionRole(subject); u != want.user || w != want.write {
			t.Errorf("%q → %q %v, se esperaba %q %v", subject, u, w, want.user, want.write)
		}
	}
}

// Un pase de lectura lee, pero no reinicia nada; uno sin rol (de un backend
// de antes de la v5) cuenta como de lectura. Mutantes: no mirar el rol;
// dar escritura al pase sin rol.
func TestAReadPassCannotRestartAService(t *testing.T) {
	exp := time.Now().Add(time.Minute).Unix()
	for _, subject := range []string{"u-vera|r", "u-vera"} {
		tok := sign("k", "srv-1", subject, exp)
		get := httptest.NewRequest(http.MethodGet, "/api/v1/services/x/logs", nil)
		get.Header.Set("Authorization", "Bearer "+tok)
		if code := servir("k", "srv-1", get); code != http.StatusOK {
			t.Errorf("%s leyendo → %d", subject, code)
		}
		post := httptest.NewRequest(http.MethodPost, "/api/v1/services/x/force-update", nil)
		post.Header.Set("Authorization", "Bearer "+tok)
		if code := servir("k", "srv-1", post); code != http.StatusForbidden {
			t.Errorf("%s reiniciando → %d, se esperaba 403", subject, code)
		}
	}
}
