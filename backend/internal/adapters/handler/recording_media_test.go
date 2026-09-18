package handler

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Un bucket de mentira que apunta lo que le piden.
type fakeStore struct {
	askedKey   string
	askedRange string
	obj        *mediastore.Object
	err        error
	deleted    []string
}

func (f *fakeStore) Enabled() bool { return true }

func (f *fakeStore) GetRange(_ context.Context, key, rng string) (*mediastore.Object, error) {
	f.askedKey, f.askedRange = key, rng
	if f.err != nil {
		return nil, f.err
	}
	return f.obj, nil
}

func (f *fakeStore) Delete(_ context.Context, keys ...string) error {
	f.deleted = append(f.deleted, keys...)
	return nil
}

func mediaReq(id, rng, token string) *http.Request {
	url := "/api/v1/recordings/" + id + "/media"
	if token != "" {
		url += "?token=" + token
	}
	r := httptest.NewRequest(http.MethodGet, url, nil)
	if rng != "" {
		r.Header.Set("Range", rng)
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// tokenPara acuña una entrada válida para un miembro de esa organización.
//
// Con el mismo secreto que valida el proxy: lo que se prueba aquí no es la
// firma, sino que el proxy **exige** una y mira a qué organización pertenece.
func tokenPara(t *testing.T, orgID string) string {
	t.Helper()
	par, err := repository.GenerateTokens("u-ana", "ana", false,
		[]domain.OrgMembershipClaim{{OrgID: orgID, Role: domain.OrgRoleMember}})
	if err != nil {
		t.Fatal(err)
	}
	return par.AccessToken
}

// mediaSetup deja una grabación lista y devuelve el handler y el bucket falso.
func mediaSetup(t *testing.T, finalKey string) (*recordingHandler, *fakeStore, *domain.Recording) {
	t.Helper()
	db, cleanup := voiceDB(t)
	t.Cleanup(cleanup)

	if err := db.AutoMigrate(&domain.Recording{}, &domain.RecordingTrack{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewRecordingRepository(db)
	rec := &domain.Recording{
		BaseModel: domain.BaseModel{ID: "rec-1"},
		OrgID:     "org-1", SpaceID: "esp-1", Room: "voice:esp-1", StartedBy: "u-ana",
		Status: domain.RecordingReady, FinalKey: finalKey,
		FinalContentType: "video/mp4", FinalBytes: 1000,
	}
	if err := repo.Create(rec); err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{obj: &mediastore.Object{
		Body: io.NopCloser(strings.NewReader("0123456789")), ContentType: "video/mp4", Size: 10,
	}}
	svc := service.NewRecordingService(repo, nil, nil, store, "recordings", true, 240)
	return &recordingHandler{svc: svc}, store, rec
}

const claveMontaje = "recordings/org-1/esp-1/rec-1/final.mp4"

// Quien no pertenece a la organización no se entera ni de que existe.
//
// Y **404 antes que cualquier otra cosa**: un 401 o un 403 ya confirmarían que
// esa grabación está ahí a alguien que sólo tiene un identificador.
func TestMediaIsANotFoundForOutsiders(t *testing.T) {
	h, store, _ := mediaSetup(t, claveMontaje)

	for _, caso := range []struct{ nombre, id, token string }{
		{"sin credencial", "rec-1", ""},
		{"una grabación que no existe", "rec-inventada", ""},
		// El que de verdad importa: una credencial **válida**, de otra
		// organización. Sin la comprobación de pertenencia, el identificador
		// de la grabación sería toda la seguridad que hay.
		{"con la credencial de otra organización", "rec-1", tokenPara(t, "org-2")},
		{"con una credencial inventada", "rec-1", "no.es.un.token"},
	} {
		t.Run(caso.nombre, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.Media(w, mediaReq(caso.id, "", caso.token))
			if w.Code != http.StatusNotFound {
				t.Fatalf("%d: %s", w.Code, w.Body.String())
			}
		})
	}
	if store.askedKey != "" {
		t.Fatalf("no se puede haber tocado el bucket: %q", store.askedKey)
	}
}

// Un `Range` sale como 206 con su `Content-Range`, y el rango llega a S3 tal
// cual.
//
// Es lo que hace que arrastrar la barra de un vídeo de una hora sea inmediato.
// Los mutantes que matan: contestar siempre 200, o tragarse el `Range` y servir
// el fichero entero —las dos cosas «funcionan» y las dos obligan a bajarse la
// reunión completa para ver el minuto veinte.
func TestMediaHonoursRange(t *testing.T) {
	h, store, rec := mediaSetup(t, claveMontaje)
	store.obj.ContentRange = "bytes 0-99/100000"
	store.obj.Size = 100

	w := httptest.NewRecorder()
	h.Media(w, mediaReq(rec.ID, "bytes=0-99", tokenPara(t, "org-1")))

	if w.Code != http.StatusPartialContent {
		t.Fatalf("un Range tiene que dar 206 y dio %d: %s", w.Code, w.Body.String())
	}
	if store.askedRange != "bytes=0-99" {
		t.Fatalf("el rango llegó al bucket como %q", store.askedRange)
	}
	if got := w.Header().Get("Content-Range"); got != "bytes 0-99/100000" {
		t.Fatalf("Content-Range: %q", got)
	}
	// Y sin esto el navegador ni siquiera intenta pedir trozos.
	if w.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatal("falta Accept-Ranges")
	}
	if w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("una reunión no se queda en ninguna caché: %q", w.Header().Get("Cache-Control"))
	}
}

// Sin `Range`, 200 y el fichero entero.
func TestMediaWithoutARangeIsAPlainOK(t *testing.T) {
	h, store, rec := mediaSetup(t, claveMontaje)
	w := httptest.NewRecorder()
	h.Media(w, mediaReq(rec.ID, "", tokenPara(t, "org-1")))
	if w.Code != http.StatusOK {
		t.Fatalf("%d: %s", w.Code, w.Body.String())
	}
	if store.askedRange != "" {
		t.Fatalf("no se pidió rango y llegó %q", store.askedRange)
	}
	if w.Body.String() != "0123456789" {
		t.Fatalf("%q", w.Body.String())
	}
}

// Una grabación todavía sin montar no es un 404.
//
// «No encontrado» mandaría a buscar un fallo que no existe: la grabación está
// ahí y el mux la está montando. 409 y un código que la app pueda traducir.
func TestMediaSaysItIsStillBeingProcessed(t *testing.T) {
	// Sin clave del montaje: es lo que hay entre «para» y el mux.
	h, _, rec := mediaSetup(t, "")

	w := httptest.NewRecorder()
	h.Media(w, mediaReq(rec.ID, "", tokenPara(t, "org-1")))
	if w.Code != http.StatusConflict {
		t.Fatalf("%d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "recording-not-ready") {
		t.Fatalf("la app necesita un código que traducir: %s", w.Body.String())
	}
}
