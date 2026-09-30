package config

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// La cabecera de credenciales del registro sale del secret, para el registro
// de la imagen; sin secret no hay cabecera (imágenes públicas).
func TestRegistryAuthComesFromTheSecret(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "cac_registry_auth")
	if got := RegistryAuth(p)("ghcr.io/a/b:1"); got != "" {
		t.Errorf("sin secret hay cabecera: %q", got)
	}
	os.WriteFile(p, []byte(`{"username":"x-access-token","password":"ghp_abc"}`), 0o600)
	raw, err := base64.URLEncoding.DecodeString(RegistryAuth(p)("ghcr.io/a/b:1"))
	if err != nil {
		t.Fatal(err)
	}
	var h map[string]string
	json.Unmarshal(raw, &h)
	if h["username"] != "x-access-token" || h["password"] != "ghp_abc" || h["serveraddress"] != "ghcr.io" {
		t.Errorf("la cabecera no es la esperada: %v", h)
	}
}
