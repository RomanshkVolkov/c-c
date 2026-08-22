/*
 * Cuánto aguanta este webview pintando vídeo, medido dentro de él.
 *
 * La pregunta que contesta es la mitad del problema: independientemente de lo
 * que cueste cruzar la frontera Rust→webview, ¿puede el webview convertir y
 * pintar N tramas por segundo? Si la respuesta ya es que no, no hace falta
 * medir el transporte.
 *
 * Se comparan los tres caminos posibles con los mismos píxeles:
 *   1. `VideoFrame` de WebCodecs a partir de I420 crudo → drawImage
 *   2. `putImageData` con RGBA convertido en JavaScript
 *   3. `createImageBitmap` de un Blob JPEG → drawImage
 *
 *   gcc bench.c -o bench $(pkg-config --cflags --libs webkit2gtk-4.1) && ./bench
 */
#include <webkit2/webkit2.h>
#include <stdio.h>

static const char *GUION =
"(async () => {\n"
"  try {\n"
"  const out = {};\n"
"  const medir = async (nombre, veces, fn) => {\n"
"    await fn();                       // una de calentamiento, fuera de la cuenta\n"
"    const t0 = performance.now();\n"
"    for (let i = 0; i < veces; i++) await fn();\n"
"    const ms = (performance.now() - t0) / veces;\n"
"    out[nombre] = { ms: +ms.toFixed(3), fps: Math.round(1000 / ms) };\n"
"  };\n"
"  for (const [w, h, etiqueta] of [[640,360,'640x360'], [1280,720,'1280x720'], [1920,1080,'1920x1080']]) {\n"
"    const ySize = w * h, uvSize = (w >> 1) * (h >> 1);\n"
"    const i420 = new Uint8Array(ySize + uvSize * 2);\n"
"    for (let i = 0; i < i420.length; i++) i420[i] = i & 0xff;\n"
"    const lienzo = new OffscreenCanvas(w, h);\n"
"    const ctx = lienzo.getContext('2d');\n"
"\n"
"    // 1 · WebCodecs: la trama cruda se envuelve y la pinta el motor.\n"
"    try {\n"
"      await medir('videoframe_' + etiqueta, 60, async () => {\n"
"        const f = new VideoFrame(i420, { format: 'I420', codedWidth: w, codedHeight: h, timestamp: 0 });\n"
"        ctx.drawImage(f, 0, 0);\n"
"        f.close();\n"
"      });\n"
"    } catch (e) { out['videoframe_' + etiqueta] = 'error: ' + e.message; }\n"
"\n"
"    // 2 · A mano: YUV→RGBA en JavaScript y putImageData.\n"
"    const rgba = new Uint8ClampedArray(w * h * 4);\n"
"    try {\n"
"      await medir('putimagedata_' + etiqueta, 20, async () => {\n"
"        for (let j = 0, p = 0; j < ySize; j++, p += 4) {\n"
"          const y = i420[j];\n"
"          rgba[p] = y; rgba[p+1] = y; rgba[p+2] = y; rgba[p+3] = 255;\n"
"        }\n"
"        ctx.putImageData(new ImageData(rgba, w, h), 0, 0);\n"
"      });\n"
"    } catch (e) { out['putimagedata_' + etiqueta] = 'error: ' + e.message; }\n"
"\n"
"    // 3 · JPEG: lo que costaría descodificarlo aquí (sin contar codificarlo en Rust).\n"
"    try {\n"
"      const blob = await lienzo.convertToBlob({ type: 'image/jpeg', quality: 0.7 });\n"
"      out['jpeg_bytes_' + etiqueta] = blob.size;\n"
"      await medir('jpeg_decode_' + etiqueta, 30, async () => {\n"
"        const bmp = await createImageBitmap(blob);\n"
"        ctx.drawImage(bmp, 0, 0);\n"
"        bmp.close();\n"
"      });\n"
"    } catch (e) { out['jpeg_decode_' + etiqueta] = 'error: ' + e.message; }\n"
"  }\n"
"\n"
"  // ¿Y descodificar H.264 aquí, si le mandáramos trozos codificados?\n"
"  try {\n"
"    const s = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 1280, codedHeight: 720 });\n"
"    out.h264_decode_soportado = s.supported;\n"
"    out.h264_hardware = s.config && s.config.hardwareAcceleration;\n"
"  } catch (e) { out.h264_decode_soportado = 'error: ' + e.message; }\n"
"  try {\n"
"    const s = await VideoDecoder.isConfigSupported({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });\n"
"    out.vp8_decode_soportado = s.supported;\n"
"  } catch (e) { out.vp8_decode_soportado = 'error: ' + e.message; }\n"
"  out.formatos_videoframe = ['I420','NV12','RGBA','BGRA'].filter(f => {\n"
"    try { const n = f === 'I420' ? 96*54*3/2 : 96*54*4;\n"
"          new VideoFrame(new Uint8Array(n), {format:f, codedWidth:96, codedHeight:54, timestamp:0}).close();\n"
"          return true; } catch (e) { return false; }\n"
"  });\n"
"  return JSON.stringify(out);\n"
"})()";

static void titulo(GObject *obj, GParamSpec *ps, gpointer datos) {
  (void)ps;
  const char *t = webkit_web_view_get_title(WEBKIT_WEB_VIEW(obj));
  if (!t || t[0] != 'R' || t[1] != ':') return;
  printf("%s\n", t + 2);
  g_main_loop_quit((GMainLoop *)datos);
}
static void cargado(WebKitWebView *vista, WebKitLoadEvent ev, gpointer datos) {
  (void)datos;
  if (ev != WEBKIT_LOAD_FINISHED) return;
  webkit_web_view_evaluate_javascript(vista, GUION, -1, NULL, NULL, NULL, NULL, NULL);
}
int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  GtkWidget *ventana = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_default_size(GTK_WINDOW(ventana), 1, 1);
  WebKitWebView *vista = WEBKIT_WEB_VIEW(webkit_web_view_new());
  WebKitSettings *aj = webkit_web_view_get_settings(vista);
  webkit_settings_set_enable_webgl(aj, TRUE);
  webkit_settings_set_enable_developer_extras(aj, TRUE);
  gtk_container_add(GTK_CONTAINER(ventana), GTK_WIDGET(vista));
  gtk_widget_show_all(ventana);
  GMainLoop *bucle = g_main_loop_new(NULL, FALSE);
  g_signal_connect(vista, "notify::title", G_CALLBACK(titulo), bucle);
  g_signal_connect(vista, "load-changed", G_CALLBACK(cargado), bucle);
  webkit_web_view_load_html(vista, "<html><body>bench</body></html>", "https://cac.local/");
  g_main_loop_run(bucle);
  return 0;
}
