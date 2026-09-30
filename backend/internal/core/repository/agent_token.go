package repository

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ─── Identidad del agente de cada servidor ────────────────────────────────────
//
// Dos piezas por servidor, y cada una sirve para una cosa:
//
//   - el **token** (`cac_agent_…`): con él el agente se presenta al backend
//     cuando pregunta si hay trabajo. Del token sólo se guarda el HMAC, como
//     con los PAT: una fuga de la base no da una credencial usable.
//   - la **llave de sesión**: con ella el agente verifica, sin preguntarle a
//     nadie, los pases cortos con los que la app le pide logs y estadísticas.
//     No se guarda: se **deriva** del secreto del backend y de una sal por
//     servidor, así que el backend puede firmar pases sin tener nada
//     descifrable en la base. Reacuñar cambia la sal y caduca todos los pases.
//
// El agente es otro módulo (`swarm-manage`) y tiene su propia copia de
// `VerifyAgentSession`. Que las dos digan lo mismo lo fija un vector de prueba
// idéntico en las dos: `TestAgentSessionVector`.

// AgentTokenPrefix distingue un token de agente de un PAT o una llave de ingesta.
const AgentTokenPrefix = "cac_agent_"

func agentSecret() []byte {
	// El mismo secreto que las llaves de ingesta y los PAT, separado por el
	// dominio que se mezcla en cada HMAC ("agent:", "agent-session-key:").
	return ingestSecret()
}

// HashAgentToken es lo único que se guarda del token.
func HashAgentToken(plain string) []byte {
	mac := hmac.New(sha256.New, agentSecret())
	mac.Write([]byte("agent:" + plain))
	return mac.Sum(nil)
}

// GenerateAgentToken acuña (token, hash, sal nueva). Devolver la sal aquí y no
// aparte es lo que obliga a que reacuñar la cambie siempre.
func GenerateAgentToken() (plain string, hash []byte, salt string, err error) {
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", nil, "", fmt.Errorf("failed to generate agent token: %w", err)
	}
	s := make([]byte, 16)
	if _, err = rand.Read(s); err != nil {
		return "", nil, "", fmt.Errorf("failed to generate agent salt: %w", err)
	}
	plain = AgentTokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	return plain, HashAgentToken(plain), hex.EncodeToString(s), nil
}

// AgentSessionKey deriva la llave de sesión de un servidor. Hex, porque viaja
// como texto a un Docker secret.
func AgentSessionKey(serverID, salt string) string {
	mac := hmac.New(sha256.New, agentSecret())
	fmt.Fprintf(mac, "agent-session-key:%s:%s", serverID, salt)
	return hex.EncodeToString(mac.Sum(nil))
}

// SignAgentSession firma un pase `<b64 usuario>.<exp>.<hmac hex>` para un
// servidor. El usuario va dentro para que el agente pueda registrar quién
// pidió qué; lo cubre la firma, así que no se puede cambiar.
func SignAgentSession(sessionKey, serverID, userID string, expUnix int64) string {
	u := base64.RawURLEncoding.EncodeToString([]byte(userID))
	return fmt.Sprintf("%s.%d.%s", u, expUnix, agentSessionMAC(sessionKey, serverID, userID, expUnix))
}

func agentSessionMAC(sessionKey, serverID, userID string, expUnix int64) string {
	mac := hmac.New(sha256.New, []byte(sessionKey))
	fmt.Fprintf(mac, "agent-session:%s:%s:%d", serverID, userID, expUnix)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyAgentSession es la misma comprobación que hace el agente. Aquí sólo la
// usan las pruebas, para que las dos copias no puedan divergir sin que se note.
func VerifyAgentSession(sessionKey, serverID, token string, now time.Time) (userID string, ok bool) {
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
	want := agentSessionMAC(sessionKey, serverID, string(raw), exp)
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[2])) != 1 {
		return "", false
	}
	return string(raw), true
}
