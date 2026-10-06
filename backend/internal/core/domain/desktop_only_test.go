package domain

import "testing"

// Lo que es sólo del escritorio se reconoce por prefijo entero: `/servers` y lo
// que cuelga de él, no cualquier ruta que empiece igual. Mutantes: comparar
// con HasPrefix a secas; olvidar un prefijo.
func TestDesktopOnlyPaths(t *testing.T) {
	si := []string{"/api/v1/servers", "/api/v1/servers/", "/api/v1/servers/x/integrations", "/api/v1/auth/tokens", "/api/v1/auth/tokens/t1"}
	no := []string{"/api/v1/serversx", "/api/v1/auth/tokensx", "/api/v1/auth/refresh", "/api/v1/tasks/servers"}
	for _, p := range si {
		if !DesktopOnlyPath(p) {
			t.Errorf("%s debería ser sólo del escritorio", p)
		}
	}
	for _, p := range no {
		if DesktopOnlyPath(p) {
			t.Errorf("%s no es sólo del escritorio", p)
		}
	}
}
