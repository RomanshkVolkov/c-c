package domain

import "testing"

// El enlace de un aviso que escribe un agente sólo puede llevar dentro de la
// app. Mutantes: aceptar `//otro.sitio` (protocolo relativo: sale fuera);
// aceptar `https://`; aceptar la barra invertida que algunos navegadores
// leen como `/`.
func TestASelfNoticeOnlyLinksInsideTheApp(t *testing.T) {
	for link, want := range map[string]bool{
		"/tasks?item=abc":      true,
		"/":                    true,
		"//evil.example/login": false,
		"https://evil.example": false,
		"javascript:alert(1)":  false,
		`/\evil.example`:       false,
		"tasks?item=abc":       false,
	} {
		if got := InternalLink(link); got != want {
			t.Errorf("%q → %v, se esperaba %v", link, got, want)
		}
	}
}
