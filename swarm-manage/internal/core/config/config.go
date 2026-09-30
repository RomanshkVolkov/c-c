// Package config lee la identidad del agente al arrancar.
//
// El token y la llave de sesión llegan como Docker secrets montados en
// /run/secrets —los crea la app al instalar el agente, por stdin, así que no
// aparecen en ningún argv ni en `docker service inspect`—. La dirección del
// backend y el id del servidor, que no son secretos, llegan por entorno.
package config

import (
	"os"
	"strings"
)

type Config struct {
	Port string
	// A quién le pregunta el agente si hay trabajo. Vacío: no pregunta.
	BackendURL string
	ServerID   string
	// Con él se presenta al backend.
	Token string
	// Con ella verifica los pases de la app. Vacía: la API no abre.
	SessionKey string
}

// Configured: el agente tiene identidad. Sin ella, `/api/v1` no abre — no hay
// modo «sin auth» al que caer, que es lo que era antes todo el agente.
func (c Config) Configured() bool {
	return c.SessionKey != "" && c.ServerID != ""
}

// CanPoll: además sabe a quién preguntar.
func (c Config) CanPoll() bool {
	return c.Configured() && c.BackendURL != "" && c.Token != ""
}

func Load() Config {
	return Config{
		Port:       env("PORT", "9090"),
		BackendURL: strings.TrimRight(env("CAC_URL", ""), "/"),
		ServerID:   env("CAC_SERVER_ID", ""),
		Token:      secret("CAC_AGENT_TOKEN_FILE", "/run/secrets/cac_agent_token"),
		SessionKey: secret("CAC_AGENT_SESSION_KEY_FILE", "/run/secrets/cac_agent_session_key"),
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

// secret lee un fichero de secret; la ruta se puede cambiar por entorno (para
// las pruebas y para correrlo fuera de Swarm). Un fichero que no está es un
// secret vacío, no un error: el agente arranca y dice por qué no abre.
func secret(pathEnv, fallback string) string {
	b, err := os.ReadFile(env(pathEnv, fallback))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
