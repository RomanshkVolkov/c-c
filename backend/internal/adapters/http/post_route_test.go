package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type stubPosts struct{}

func (stubPosts) List(w http.ResponseWriter, r *http.Request)          { ok(w, r) }
func (stubPosts) Create(w http.ResponseWriter, r *http.Request)        { ok(w, r) }
func (stubPosts) Get(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func (stubPosts) Delete(w http.ResponseWriter, r *http.Request)        { ok(w, r) }
func (stubPosts) Comment(w http.ResponseWriter, r *http.Request)       { ok(w, r) }
func (stubPosts) DeleteComment(w http.ResponseWriter, r *http.Request) { ok(w, r) }
func (stubPosts) React(w http.ResponseWriter, r *http.Request)         { ok(w, r) }
func (stubPosts) Seen(w http.ResponseWriter, r *http.Request)          { ok(w, r) }
func (stubPosts) Upload(w http.ResponseWriter, r *http.Request)        { ok(w, r) }
func (stubPosts) Raw(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func (stubPosts) Update(w http.ResponseWriter, r *http.Request)        { ok(w, r) }
func (stubPosts) Pin(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func (stubPosts) Publish(w http.ResponseWriter, r *http.Request)       { ok(w, r) }
func (stubPosts) ReactComment(w http.ResponseWriter, r *http.Request)  { ok(w, r) }

// Del muro, sólo los bytes de una imagen entran sin JWT (los pide un <img>, con
// su propio `?token=` que mira el handler); todo lo demás, 401. Recorre el
// enrutado de verdad con chi.Walk, como TestOnlyThePublicCallRoutesSkipAuth.
// Mutante: colgar una ruta del muro fuera del grupo con AuthMiddleware.
func TestOnlyTheRawPostImageSkipsAuth(t *testing.T) {
	r := chi.NewRouter()
	mountPostRoutes(r, stubPosts{})
	seen, open := 0, 0
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen++
		path := strings.NewReplacer("{id}", "p", "{commentId}", "c", "{attachmentId}", "a").Replace(route)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		if strings.HasSuffix(route, "/raw") {
			open++
			if rec.Code == http.StatusUnauthorized {
				t.Errorf("%s %s pide JWT y la pide un <img>", method, route)
			}
			return nil
		}
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s sin JWT → %d, se esperaba 401", method, route, rec.Code)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen < 10 || open != 1 {
		t.Fatalf("el recorrido vio %d rutas y %d públicas", seen, open)
	}
}
