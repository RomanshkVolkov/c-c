/*
 * ¿Qué sabe hacer de verdad el WebKitGTK de esta máquina?
 *
 * Existe porque mirar los símbolos con `strings` me dio un falso negativo: las
 * clases de WebCodecs se llaman `JSWebCodecsVideoDecoder`, no
 * `JSVideoDecoder`, y busqué el nombre equivocado. Un símbolo presente tampoco
 * demuestra que la API esté encendida — WebKit esconde cosas detrás de flags
 * de característica que están apagadas por defecto.
 *
 * Así que se pregunta en ejecución, que es la única respuesta que vale: se
 * carga una página en blanco y se evalúa JavaScript de verdad.
 *
 *   gcc probe.c -o probe $(pkg-config --cflags --libs webkit2gtk-4.1) && ./probe
 */
#include <webkit2/webkit2.h>
#include <stdio.h>

static const char *GUION =
    "JSON.stringify({"
    "  RTCPeerConnection: typeof RTCPeerConnection,"
    "  getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),"
    "  MediaSource: typeof MediaSource,"
    "  mseH264: (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported)"
    "      ? MediaSource.isTypeSupported('video/mp4; codecs=\"avc1.42E01E\"') : null,"
    "  VideoDecoder: typeof VideoDecoder,"
    "  VideoEncoder: typeof VideoEncoder,"
    "  VideoFrame: typeof VideoFrame,"
    "  EncodedVideoChunk: typeof EncodedVideoChunk,"
    "  WebGPU: typeof navigator.gpu,"
    "  WebGL2: (function(){try{return !!document.createElement('canvas').getContext('webgl2');}catch(e){return false;}})(),"
    "  OffscreenCanvas: typeof OffscreenCanvas,"
    "  createImageBitmap: typeof createImageBitmap,"
    "  SharedArrayBuffer: typeof SharedArrayBuffer,"
    "  userAgent: navigator.userAgent"
    "})";

static void listo(GObject *obj, GAsyncResult *res, gpointer datos) {
  GError *err = NULL;
  JSCValue *v = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(obj), res, &err);
  if (!v) {
    fprintf(stderr, "no se pudo evaluar: %s\n", err ? err->message : "?");
    g_clear_error(&err);
  } else {
    char *s = jsc_value_to_string(v);
    printf("%s\n", s);
    g_free(s);
  }
  g_main_loop_quit((GMainLoop *)datos);
}

static void cargado(WebKitWebView *vista, WebKitLoadEvent ev, gpointer datos) {
  if (ev != WEBKIT_LOAD_FINISHED) return;
  webkit_web_view_evaluate_javascript(vista, GUION, -1, NULL, NULL, NULL, listo, datos);
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  /* Offscreen: no hace falta abrirle una ventana a nadie para preguntarle esto. */
  /* Ventana de verdad y no `offscreen`: sin superficie GL, GDK aborta al
     crear el contexto y no se puede preguntar por WebGL ni WebGPU. Se hace
     minúscula, aparece un instante y se cierra sola. */
  GtkWidget *ventana = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_default_size(GTK_WINDOW(ventana), 1, 1);
  WebKitWebView *vista = WEBKIT_WEB_VIEW(webkit_web_view_new());

  /* Con las características experimentales encendidas, que es lo que hace una
     app que quiere usarlas — preguntar con ellas apagadas mediría otra cosa. */
  WebKitSettings *aj = webkit_web_view_get_settings(vista);
  webkit_settings_set_enable_webgl(aj, TRUE);
  webkit_settings_set_enable_media_stream(aj, TRUE);
  webkit_settings_set_enable_webrtc(aj, TRUE);
  webkit_settings_set_enable_developer_extras(aj, TRUE);

  gtk_container_add(GTK_CONTAINER(ventana), GTK_WIDGET(vista));
  gtk_widget_show_all(ventana);

  GMainLoop *bucle = g_main_loop_new(NULL, FALSE);
  g_signal_connect(vista, "load-changed", G_CALLBACK(cargado), bucle);
  webkit_web_view_load_html(vista, "<html><body>probe</body></html>", "https://cac.local/");
  g_main_loop_run(bucle);
  return 0;
}
