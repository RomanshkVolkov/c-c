package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// RequireSession exige un pase de la app en todo lo que cuelga de aquí.
//
// El agente habla con el socket de Docker de la máquina: leer los logs de
// cualquier servicio o reiniciarlo es poder mucho. Hasta ahora bastaba con
// saber la IP. El pase lo firma el backend con la llave de sesión de este
// servidor y dura minutos; el agente lo verifica **sin preguntarle a nadie**,
// así que funciona aunque el backend esté caído.
//
// Va en `Authorization: Bearer`, o en `?access_token=` **sólo en GET**: el
// stream de logs es un `EventSource`, que no sabe mandar cabeceras. Nada que
// cambie algo acepta el pase por la URL, que acaba en logs de proxies.
//
// Sin llave configurada contesta 503 a todo: no hay modo abierto al que caer.
func RequireSession(sessionKey, serverID string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if sessionKey == "" || serverID == "" {
				writeError(w, http.StatusServiceUnavailable, "agent-unconfigured")
				return
			}
			tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if tok == "" && r.Method == http.MethodGet {
				tok = r.URL.Query().Get("access_token")
			}
			if _, ok := VerifySession(sessionKey, serverID, tok, time.Now()); !ok {
				writeError(w, http.StatusUnauthorized, "invalid-session")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// VerifySession es la copia del agente de `repository.VerifyAgentSession` del
// backend. Si se cambia una hay que cambiar la otra: las dos llevan el mismo
// vector de prueba (`TestSessionVector` aquí, `TestAgentSessionVector` allí).
func VerifySession(sessionKey, serverID, token string, now time.Time) (userID string, ok bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || now.Unix() > exp {
		return "", false
	}
	mac := hmac.New(sha256.New, []byte(sessionKey))
	fmt.Fprintf(mac, "agent-session:%s:%s:%d", serverID, string(raw), exp)
	want := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[2])) != 1 {
		return "", false
	}
	return string(raw), true
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"success":false,"error":%q}`, msg)
}
