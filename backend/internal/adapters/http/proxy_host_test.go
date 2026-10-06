package http

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// El dominio del proxy de integraciones sólo sirve el proxy: una herramienta
// que corre ahí no puede llamar a la API de cac desde su propio origen. El de
// cac sigue sirviéndolo todo. Mutante: quitar la guarda; comparar mal el host.
func TestTheToolsHostServesOnlyTheProxy(t *testing.T) {
	t.Setenv("INTEGRATIONS_PROXY_HOST", "tools.guz-studio.dev")
	h := ProxyHostOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	pedir := func(url string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
		return rec.Code
	}
	if code := pedir("https://tools.guz-studio.dev/api/v1/tasks/mine"); code != http.StatusNotFound {
		t.Errorf("la API en el dominio del proxy → %d, se esperaba 404", code)
	}
	if code := pedir("https://TOOLS.guz-studio.dev:443/api/v1/auth/me"); code != http.StatusNotFound {
		t.Errorf("con mayúsculas y puerto → %d, se esperaba 404", code)
	}
	if code := pedir("https://tools.guz-studio.dev/api/v1/servers/s/integrations/i/proxy/"); code != http.StatusOK {
		t.Errorf("el proxy en su dominio → %d", code)
	}
	if code := pedir("https://cac.guz-studio.dev/api/v1/tasks/mine"); code != http.StatusOK {
		t.Errorf("la API en el dominio de cac → %d", code)
	}
}
