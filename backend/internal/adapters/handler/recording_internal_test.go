package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// La llave del mux, y sobre todo **el caso de la llave vacía**.
//
// Es el descuido clásico de una guarda como ésta: una instalación que no
// configuró la llave compara "" con "" y deja entrar a cualquiera que llegue al
// puerto. Y al puerto llega todo lo que esté dentro del clúster.
//
// El mutante que mata: quitar el `key == ""` de la condición.
func TestInternalEndpointsNeedTheMuxKey(t *testing.T) {
	llamar := func(configurada, enviada string) int {
		h := MuxKeyMiddleware(configurada)(http.HandlerFunc(
			func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) }))
		req := httptest.NewRequest(http.MethodGet, "/internal/v1/recordings/pending-mux", nil)
		if enviada != "" {
			req.Header.Set("X-API-Key", enviada)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if got := llamar("la-buena", "la-buena"); got != http.StatusTeapot {
		t.Fatalf("con la llave buena tiene que pasar, y dio %d", got)
	}
	if got := llamar("la-buena", "otra"); got != http.StatusUnauthorized {
		t.Fatalf("con una llave mala, %d", got)
	}
	if got := llamar("la-buena", ""); got != http.StatusUnauthorized {
		t.Fatalf("sin llave, %d", got)
	}
	// Los dos que importan: con la llave **sin configurar**, no pasa nadie.
	if got := llamar("", ""); got != http.StatusUnauthorized {
		t.Fatalf("sin llave configurada y sin mandarla, %d", got)
	}
	if got := llamar("", "loquesea"); got != http.StatusUnauthorized {
		t.Fatalf("sin llave configurada, ninguna vale: %d", got)
	}
}

// Y un prefijo de la llave buena tampoco cuela: la comparación es en tiempo
// constante, pero lo que se prueba aquí es que además es completa.
func TestAPrefixOfTheKeyIsNotTheKey(t *testing.T) {
	h := MuxKeyMiddleware("clave-larga-de-verdad")(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("X-API-Key", "clave-larga")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("%d", rec.Code)
	}
}
