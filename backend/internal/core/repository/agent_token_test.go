package repository

import (
	"testing"
	"time"
)

// El vector compartido con el agente.
//
// El backend firma los pases y el agente (`swarm-manage`, otro módulo de Go)
// los verifica con su propia copia del algoritmo. Si las dos copias
// divergieran —un separador distinto, el orden de los campos—, la app dejaría
// de poder hablarle a ningún agente y ninguna prueba de un solo lado lo vería.
// Por eso **el mismo vector** está en
// `swarm-manage/internal/adapters/middleware/auth_test.go`: si se cambia aquí,
// hay que cambiarlo allí, y ésa es la idea.
func TestAgentSessionVector(t *testing.T) {
	const (
		key    = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
		server = "srv-1"
		user   = "u-ana"
		exp    = int64(1900000000)
		want   = "dS1hbmE.1900000000.c2495462c61f43dcdf008bbf99ee63daceab9c7badc9c3c33169d905dfc10ea5"
	)
	got := SignAgentSession(key, server, user, exp)
	if got != want {
		t.Fatalf("el pase cambió de forma:\n got %s\nwant %s", got, want)
	}
	antes := time.Unix(exp-60, 0)
	if u, ok := VerifyAgentSession(key, server, got, antes); !ok || u != user {
		t.Fatalf("el pase recién firmado no verifica: %q %v", u, ok)
	}
}

// Un pase vale para un servidor, un usuario y hasta una hora. Nada más.
func TestAnAgentSessionIsBoundToItsServerAndExpiry(t *testing.T) {
	key := AgentSessionKey("srv-1", "sal")
	exp := time.Now().Add(5 * time.Minute)
	tok := SignAgentSession(key, "srv-1", "u-ana", exp.Unix())

	if _, ok := VerifyAgentSession(key, "srv-1", tok, time.Now()); !ok {
		t.Fatal("el pase bueno no verifica")
	}
	if _, ok := VerifyAgentSession(key, "srv-2", tok, time.Now()); ok {
		t.Error("un pase de srv-1 no puede abrir srv-2")
	}
	if _, ok := VerifyAgentSession(key, "srv-1", tok, exp.Add(time.Second)); ok {
		t.Error("un pase caducado sigue abriendo")
	}
	if _, ok := VerifyAgentSession(AgentSessionKey("srv-1", "otra-sal"), "srv-1", tok, time.Now()); ok {
		t.Error("reacuñar cambia la sal y tiene que tumbar los pases viejos")
	}
	// Cambiar el usuario de dentro sin volver a firmar.
	otro := SignAgentSession(key, "srv-1", "u-beto", exp.Unix())
	falso := otro[:len(otro)-64] + tok[len(tok)-64:]
	if _, ok := VerifyAgentSession(key, "srv-1", falso, time.Now()); ok {
		t.Error("se puede cambiar el usuario de un pase sin la llave")
	}
}

// El token se guarda como HMAC y con su dominio: el mismo texto no da el
// mismo hash como PAT, así que un token de agente no abre la API como persona.
func TestAnAgentTokenIsNotAPersonalToken(t *testing.T) {
	plain, hash, salt, err := GenerateAgentToken()
	if err != nil {
		t.Fatal(err)
	}
	if string(HashAgentToken(plain)) != string(hash) {
		t.Fatal("el hash devuelto no es el del token")
	}
	if string(HashPAT(plain)) == string(hash) {
		t.Error("el hash de agente coincide con el de PAT: comparten dominio")
	}
	_, _, salt2, _ := GenerateAgentToken()
	if salt == "" || salt == salt2 {
		t.Error("cada token tiene que traer su propia sal")
	}
}

// El mismo vector que `TestSessionRoleVector` del agente: el rol va al final
// del sujeto firmado. Si cambia uno, cambia el otro.
func TestAgentSubjectVector(t *testing.T) {
	if got := AgentSubject("u-ana", true); got != "u-ana|w" {
		t.Errorf("escritura → %q", got)
	}
	if got := AgentSubject("u-ana", false); got != "u-ana|r" {
		t.Errorf("lectura → %q", got)
	}
}
