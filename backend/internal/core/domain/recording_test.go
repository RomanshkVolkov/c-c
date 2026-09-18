package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

// Los tres finales son finales.
//
// Lo que esto impide es una grabación que alguien ya vio volviendo a
// `recording`: la app enseñaría REC en una sala donde no hay nadie grabando, y
// el reloj se pondría a buscar pistas de una llamada que terminó hace días.
// Volver a montar una que falló es otra cosa —un `retry` explícito— y cuando
// exista se escribe en la tabla con su nombre.
func TestRecordingStatesOnlyMoveForward(t *testing.T) {
	final := []RecordingStatus{RecordingReady, RecordingPartial, RecordingFailed}
	for _, from := range final {
		for _, to := range []RecordingStatus{RecordingActive, RecordingFinalizing} {
			if CanTransitionRecording(from, to) {
				t.Fatalf("%s → %s no debería poder", from, to)
			}
		}
		if !from.Terminal() {
			t.Fatalf("%s tendría que ser terminal", from)
		}
	}

	// El camino normal, entero.
	if !CanTransitionRecording(RecordingActive, RecordingFinalizing) {
		t.Fatal("parar una grabación es el caso normal")
	}
	for _, to := range final {
		if !CanTransitionRecording(RecordingFinalizing, to) {
			t.Fatalf("finalizing → %s es a donde lleva el mux", to)
		}
	}

	// La llamada en la que ningún egress llegó a escribir nada: no hay nada que
	// finalizar, y obligarla a pasar por `finalizing` dejaría una fila esperando
	// a un mux que no tiene material.
	if !CanTransitionRecording(RecordingActive, RecordingFailed) {
		t.Fatal("una grabación sin una sola pista muere directa")
	}

	// Quedarse donde está es legal: un tick que reconcilia sin novedad no es un
	// error.
	if !CanTransitionRecording(RecordingActive, RecordingActive) {
		t.Fatal("un tick sin novedad no es una transición ilegal")
	}
}

// Las cámaras no se graban, y eso es producto, no configuración.
//
// El mutante que mata: quitar el filtro y grabar todo lo que llegue. Se notaría
// en la factura y en la cara de quien salga en el vídeo.
func TestCamerasAreNeverRecordable(t *testing.T) {
	for _, s := range []string{"CAMERA", "SOURCE_CAMERA", "camera", "UNKNOWN", ""} {
		if Recordable(s) {
			t.Fatalf("%q no se graba", s)
		}
	}
	// Las dos formas del enum: el JSON de Twirp ha emitido las dos según
	// versión, y una pista que no se reconoce se descarta **en silencio**. Para
	// una cámara eso es lo correcto; para un micro sería la llamada entera sin
	// voz y sin un error que lo diga.
	for _, s := range []string{
		"MICROPHONE", "SOURCE_MICROPHONE", "microphone",
		"SCREEN_SHARE", "SOURCE_SCREEN_SHARE",
		"SCREEN_SHARE_AUDIO", "SOURCE_SCREEN_SHARE_AUDIO",
	} {
		if !Recordable(s) {
			t.Fatalf("%q sí se graba", s)
		}
	}
}

// La clave dice de quién es el fichero, y en ese orden.
//
// Dos mutantes que mata: intercambiar organización y espacio —que mezclaría los
// ficheros de dos clientes en el mismo prefijo sin romper nada visible— y
// sacarla del prefijo que la credencial de Egress tiene permitido escribir.
func TestTrackKeyLivesUnderTheRecordingPrefix(t *testing.T) {
	k := RecordingTrackKey("recordings", "org-1", "space-2", "rec-3",
		"MICROPHONE", "user-4", "TR_abc")
	want := "recordings/org-1/space-2/rec-3/microphone-user-4-TR_abc"
	if k != want {
		t.Fatalf("\n  es: %s\n  debería: %s", k, want)
	}

	f := RecordingFinalKey("recordings", "org-1", "space-2", "rec-3", ".mp4")
	if f != "recordings/org-1/space-2/rec-3/final.mp4" {
		t.Fatalf("%s", f)
	}
	// Con o sin punto, la misma clave: el llamante tiene `.mp4` en un sitio y
	// `mp4` en otro, y dos claves distintas para el mismo fichero significan un
	// reintento que duplica en vez de sobrescribir.
	if RecordingFinalKey("recordings", "o", "s", "r", "mp4") !=
		RecordingFinalKey("recordings", "o", "s", "r", ".mp4") {
		t.Fatal("el punto de la extensión no puede cambiar la clave")
	}
}

// Nada de lo que venga de fuera puede sacar el objeto de su sitio.
//
// La identidad la pone el SFU a partir del token que firmamos nosotros, así que
// hoy es un id de cac. Esto es el cinturón: una barra convertiría
// `recordings/org/space/rec/mic-<id>-<sid>` en una ruta distinta — fuera del
// prefijo que la credencial puede escribir, o dentro del de otra organización.
func TestNoKeySegmentCanEscapeItsPrefix(t *testing.T) {
	k := RecordingTrackKey("recordings", "org-1", "space-2", "rec-3",
		"MICROPHONE", "../../otra-org/colado", "TR_abc")
	if strings.Count(k, "/") != 4 {
		t.Fatalf("la clave cambió de profundidad: %s", k)
	}
	if !strings.HasPrefix(k, "recordings/org-1/space-2/rec-3/") {
		t.Fatalf("se salió de su sitio: %s", k)
	}

	// Y un segmento vacío tampoco colapsa la ruta: `a//b` no es `a/b` en S3,
	// pero una clave con un tramo vacío es imposible de leer de un listado.
	if strings.Contains(RecordingTrackKey("recordings", "", "s", "r", "MICROPHONE", "", ""), "//") {
		t.Fatal("un segmento vacío no puede dejar una barra doble")
	}
}

// Una pista terminal es la que el reloj puede dejar de mirar.
//
// El mutante que mata: contar `starting` o `active` como terminal, que cerraría
// la grabación mientras un egress sigue subiendo su fichero — y el mux montaría
// un multipart a medias.
func TestOnlyFinishedTracksAreTerminal(t *testing.T) {
	for _, s := range []string{TrackComplete, TrackFailed} {
		if !TrackTerminal(s) {
			t.Fatalf("%q ya no cambia sola", s)
		}
	}
	for _, s := range []string{TrackStarting, TrackActive, ""} {
		if TrackTerminal(s) {
			t.Fatalf("%q todavía puede cambiar", s)
		}
	}
}

// Las claves del bucket no salen a la app. Ninguna.
//
// El proxy existe para que ver una grabación pase por cac: con la clave y el
// nombre del bucket, cualquiera con la respuesta en la mano tiene la mitad del
// camino hecho para ir a buscarla por fuera. Y una clave filtrada no se puede
// retirar: se queda en el historial de peticiones de quien la vio.
//
// El mutante que mata: cambiar `json:"-"` por `json:"objectKey"`.
func TestObjectKeysNeverReachTheClient(t *testing.T) {
	rec := Recording{
		OrgID: "org-1", SpaceID: "esp-1", StartedBy: "u-1",
		FinalKey: "recordings/org-1/esp-1/rec-1/final.mp4",
	}
	tracks := []RecordingTrack{{
		TrackSid: "TR_1", ObjectKey: "recordings/org-1/esp-1/rec-1/microphone-u-1-TR_1.ogg",
		EgressID: "EG_1",
	}}
	b, err := json.Marshal(RecordingResponse{Recording: rec, Tracks: tracks})
	if err != nil {
		t.Fatal(err)
	}
	for _, prohibido := range []string{
		"recordings/", "objectKey", "object_key", "finalKey", "final_key",
		// El id del egress tampoco: es un identificador del SFU, y la app no
		// tiene ninguna llamada que hacer con él.
		"EG_1", "egressId",
	} {
		if strings.Contains(string(b), prohibido) {
			t.Fatalf("la respuesta lleva %q:\n%s", prohibido, b)
		}
	}
	// Y lo que sí tiene que llegar, llega: sin esto la prueba pasaría con una
	// respuesta vacía.
	for _, necesario := range []string{`"spaceId":"esp-1"`, `"trackSid":"TR_1"`} {
		if !strings.Contains(string(b), necesario) {
			t.Fatalf("falta %s en la respuesta:\n%s", necesario, b)
		}
	}
}

// Un prefijo anidado sigue siendo un prefijo.
//
// Esto lo encontró la primera prueba contra un S3 de verdad, y no podía salir
// antes: con `RECORDINGS_PREFIX=recordings/gate`, el prefijo pasaba por el
// mismo saneador que una identidad y la barra se convertía en guion. La clave
// quedaba `recordings-gate/…` — **fuera del rincón que la credencial de Egress
// puede escribir**—, así que cada pista moría con un `AccessDenied` que sólo se
// veía minutos después de colgar.
//
// Lo que se protege aquí son dos cosas a la vez: que la barra del prefijo
// sobreviva, y que la del resto siga sin sobrevivir.
func TestANestedPrefixKeepsItsSlashes(t *testing.T) {
	k := RecordingTrackKey("recordings/gate", "org-1", "space-2", "rec-3",
		"MICROPHONE", "user-4", "TR_abc")
	if !strings.HasPrefix(k, "recordings/gate/") {
		t.Fatalf("el prefijo perdió su barra: %s", k)
	}
	if RecordingFinalKey("media/recordings/", "o", "s", "r", "mp4") !=
		"media/recordings/o/s/r/final.mp4" {
		t.Fatalf("%s", RecordingFinalKey("media/recordings/", "o", "s", "r", "mp4"))
	}
	// Y la barra de una identidad **sigue sin** sobrevivir: lo que se ha
	// relajado es el prefijo, que es configuración, no lo que viene de fuera.
	if strings.Contains(
		RecordingTrackKey("recordings", "o", "s", "r", "MICROPHONE", "a/b", "TR_1"),
		"a/b") {
		t.Fatal("una identidad con barra cambiaría el objeto de sitio")
	}
	// Un prefijo que se queda en nada cae al de siempre en vez de dejar la
	// clave empezando por barra, que en S3 es un objeto con nombre raro que no
	// aparece donde nadie lo busca.
	if got := RecordingTrackKey("/", "o", "s", "r", "MICROPHONE", "u", "TR_1"); !strings.HasPrefix(got, RecordingPrefixDefault+"/") {
		t.Fatalf("un prefijo vacío tiene que caer al de siempre: %s", got)
	}
}
