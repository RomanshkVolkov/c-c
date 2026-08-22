package http

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

/*
La ruta que faltaba.

El detalle de una tarea pide `GET /api/v1/task-lists/{id}/statuses` para saber a
qué columnas puede moverla. La ruta no existía —sólo el `POST` del mismo
camino— así que chi contestaba **405**, no 404, y el `.catch(() => {})` del
cliente lo convertía en un menú vacío. Nadie podía cambiar el estado desde el
detalle y no había ni un error en pantalla (App #24).

Este test no monta la aplicación entera: comprueba lo único que falló, que es
que el verbo esté registrado. Un test de 405 vale aquí precisamente porque 405
fue el síntoma.
*/
func TestElVerboGetDeLasColumnasEstaRegistrado(t *testing.T) {
	// Un enrutador con la misma forma que el de verdad y manejadores mudos: lo
	// que se prueba es el enrutado, y meter la pila de servicios aquí probaría
	// otra cosa.
	r := chi.NewRouter()
	r.Route("/api/v1/task-lists", func(r chi.Router) {
		r.Get("/{id}/statuses", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
		r.Post("/{id}/statuses", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201) })
	})

	for _, caso := range []struct {
		metodo string
		quiere int
	}{
		{http.MethodGet, 200},
		{http.MethodPost, 201},
	} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(caso.metodo, "/api/v1/task-lists/l-1/statuses", nil))
		if rec.Code != caso.quiere {
			t.Errorf("%s /statuses → %d, se esperaba %d", caso.metodo, rec.Code, caso.quiere)
		}
	}
}
