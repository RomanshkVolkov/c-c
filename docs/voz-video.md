# Cámara y pantalla: lo medido, y lo que decide

Complemento de [`voz.md`](voz.md), que cuenta el motor de audio. Esto es el
vídeo, que tiene un problema propio.

Todo lo de aquí se midió en esta máquina (Arch/CachyOS, WebKitGTK 2.52.4,
Wayland) el 2026-08-21, y se dice **cómo**, para que se pueda repetir o
desmentir. Lo que no se midió lleva la etiqueta puesta. Los reproductores están
en `spikes/voice-native/src/bin/video.rs` y `spikes/webview-probe/`.

> **Este documento corrige a su versión anterior en dos puntos**, los dos porque
> la medición estaba mal hecha. Se dicen abajo, en §5, en vez de borrarse: cómo
> se equivocó uno vale tanto como el número.

---

## 1 · La captura de pantalla no hay que escribirla

Se planificó `scap`, `ashpd`/PipeWire y bindings de Windows Graphics Capture.
**Nada de eso hace falta.** El `libwebrtc` que ya enlazamos trae un capturador de
escritorio multiplataforma y el SDK de Rust lo expone:
`libwebrtc-0.3.45/src/desktop_capturer.rs` → `DesktopCapturer`, con
`get_source_list()`, `set_include_cursor()` y un callback por trama.

Por sistema, leyendo el wrapper y el binario precompilado:

| | Cómo captura | Dónde se ve |
|---|---|---|
| Windows | Windows Graphics Capture, DirectX de respaldo | `set_allow_wgc_screen_capturer(true)`, `webrtc-sys-0.3.42/src/desktop_capturer.cpp:34` |
| macOS | ScreenCaptureKit, **con el selector del sistema** | `set_allow_sck_system_picker`, mismo fichero |
| Linux | PipeWire vía xdg-desktop-portal | Ver abajo |

Linux era donde se esperaba el problema. El capturador de PipeWire sólo se
activa si `WEBRTC_USE_PIPEWIRE` está definido al compilar el wrapper, y ese
define no lo pone nuestro `build.rs` sino que se lee del binario precompilado.
Las dos mitades están:

```
$ ar t .../lib/libwebrtc.a | grep -i pipewire
base_capturer_pipewire.o   screencast_portal.o   shared_screencast_stream.o …

$ head -1 .../desktop_capture.ninja | grep -o '\-DWEBRTC_USE_[A-Z_]*'
-DWEBRTC_USE_PIPEWIRE   -DWEBRTC_USE_X   -DWEBRTC_USE_GIO
```

Y `webrtc-sys-build::webrtc_defines()` copia esos defines al compilar el
wrapper — lee justo esos dos `.ninja`, y su propio comentario dice que incluye
`desktop_capture.ninja` a propósito para no desalinear la ABI de
`DesktopCaptureOptions`.

### Hasta dónde llegó la prueba, y dónde se paró

Medido con `cargo run --bin video -- captura`:

| | |
|---|---|
| Enlaza | **✓**, pero hay que añadir `gio-2.0`, `glib-2.0` y `gobject-2.0` a mano. El capturador habla con el portal **por D-Bus con GIO**, y el `.a` trae los objetos pero no las dependencias del sistema. Sin eso: `undefined symbol: g_dbus_connection_signal_subscribe` y una docena más. La app de Tauri no lo necesita porque ya enlaza GTK, que arrastra GIO |
| Enumera fuentes | **✓** — una sola, sin título. Normal en Wayland: la fuente la elige el portal, no nosotros |
| Sale el diálogo del portal | **✓** |
| Llega una trama | **✗ · no lo conseguí** |

Tras aceptar el diálogo y elegir pantalla, `capture_frame()` sigue contestando
`Temporary` indefinidamente. Se descartaron por medición tres explicaciones
mías: que faltara el bucle de GLib (se añadió `g_main_context_iteration`, igual),
que el bucle fuera demasiado rápido (iba a 1,3 millones de llamadas por segundo
por un `recv_timeout` mal puesto; se bajó a 60/s, igual), y que faltara
`libpipewire` o `libEGL` (están instalados y libwebrtc los abre por `dlopen`).

**Queda sin explicar y sin medir si funciona dentro de la app**, que es donde hay
bucle de GTK, contexto EGL e identidad de aplicación para el portal — las tres
cosas que un binario pelado no tiene y que el portal suele mirar. La sospecha es
ésa, pero es sospecha. **Se prueba al implementar compartir pantalla, no antes**:
seguir peleándose con el spike es medir el spike.

### Una consecuencia de diseño

En Wayland el selector de fuentes **lo pinta el sistema**. No hay otra forma, y
es lo correcto: el permiso de grabar tu pantalla no debe concederlo una app
dibujando su propio diálogo. El `ScreenPicker.tsx` de 620 px con pestañas
Screens/Windows que pide el handoff sólo tiene sentido en Windows y en macOS con
el selector del sistema desactivado. Hay que decidir si se hace el nuestro para
esos dos, o el del sistema en los tres.

---

## 2 · Qué sabe hacer el webview, preguntado en ejecución

`strings` sobre la biblioteca **no vale** para esto: da falsos negativos por el
nombre y falsos positivos por las características apagadas. Las dos cosas pasaron
(§5). Así que se pregunta corriendo JavaScript de verdad, con
`spikes/webview-probe/probe.c`:

| | | |
|---|---|---|
| `RTCPeerConnection` | **undefined** | Confirmado: no hay WebRTC. La decisión del motor nativo sigue en pie |
| `MediaSource` | function | Y `isTypeSupported('video/mp4; codecs="avc1.42E01E"')` → **true** |
| `VideoDecoder` / `VideoEncoder` / `VideoFrame` / `EncodedVideoChunk` | **function** | **WebCodecs está**. Es el hallazgo que cambia el análisis |
| `navigator.gpu` | undefined | WebGPU está compilado —los símbolos `JSGPU*` están ahí— y **apagado**. El mejor recordatorio de por qué no fiarse de los símbolos |
| WebGL2 | true | |
| `OffscreenCanvas`, `createImageBitmap` | function | |
| `SharedArrayBuffer` | undefined | Sin memoria compartida en JS |

`webkitgtk-6.0` (GTK4), instalado en paralelo, da exactamente lo mismo: cambiar
de puerto de WebKit no arregla nada.

**Que haya WebCodecs importa mucho.** `VideoFrame` se construye desde un búfer
I420 crudo y se dibuja en un canvas sin conversión de color en JavaScript. Es
decir: existe un camino para meter tramas en el webview sin codificar nada.

---

## 3 · Cuánto cuesta codificar, medido

`cargo run --bin video`. Trama sintética con degradado —no ruido, que es el peor
caso de cualquier compresor y daría tamaños que no se parecen a una cara—,
30 repeticiones, un solo hilo, `--release`.

| Tamaño | `image` (RGB) | `jpeg-encoder` SIMD (RGB) | **`turbojpeg` (I420 planar)** | kB/trama |
|---|---|---|---|---|
| 640×360 | 12,4 ms · 80 fps | 4,1 ms · 242 fps | **0,6 ms · 1770 fps** | 9–12 |
| 1280×720 | 45,9 ms · 22 fps | 17,1 ms · 59 fps | **1,7 ms · 599 fps** | 24–36 |
| 1920×1080 | 104,9 ms · 10 fps | 41,8 ms · 24 fps | **3,8 ms · 265 fps** | 44–71 |

Los dos primeros incluyen la conversión I420→RGB, porque la necesitan.

**La diferencia de 27× no es «turbojpeg es más rápido». Es que el JPEG ya es
YCbCr por dentro.** Convertir I420 a RGB para que el codificador vuelva a
convertirlo a YCbCr es trabajo que se paga dos veces por trama, y libjpeg-turbo
es el único de los tres que acepta los planos tal como llegan. `image` y
`jpeg-encoder` sólo comen RGB o YCbCr entrelazado.

Lo que eso significa en carga real:

- **Cuatro mosaicos de cámara a 30 fps**: 0,6 × 120 = 72 ms de CPU por segundo.
  El 7 % de un núcleo.
- **Una pantalla 1080p a 30 fps**: 3,8 × 30 = 114 ms por segundo. El 11 %.
- Ancho de banda: ~1,1 MB/s los cuatro mosaicos, ~1,3 MB/s la pantalla. Contra
  los **89 MB/s** que costaría mandar 1080p30 en crudo.

Con la trama sintética el JPEG sale pequeño. Contenido real —una pantalla llena
de texto— comprime peor, quizá el triple. Sigue siendo irrelevante al lado del
crudo, y el **tiempo** de codificación apenas depende del contenido.

---

## 4 · Las cuatro salidas, revisadas

| | Cómo | Estado tras medir |
|---|---|---|
| **A · JPEG al webview** | I420 → `turbojpeg` planar → bytes crudos por `Channel` → `createImageBitmap` → canvas | **Viable, y barato.** El coste que lo descartaba era un artefacto de medir con el codificador equivocado |
| **A′ · I420 crudo + WebCodecs** | I420 → bytes crudos → `new VideoFrame(…, {format:'I420'})` → canvas | Abierto: WebCodecs existe. No cuesta CPU de codificar, pero paga 89 MB/s de transporte a 1080p30. **El transporte no está medido** |
| **B · `<video>` + fMP4** | H.264 → muxer fMP4 → protocolo propio → MSE | Posible (MSE y H.264 están) y sigue siendo el más caro de escribir: el muxer a mano es el trabajo largo. Su ventaja —descodificación por hardware— se la come tener que codificar H.264 justo antes |
| **C · Superficie nativa wgpu** | Las tramas no entran al webview; se pintan bajo o sobre él | En Windows y macOS hay plugins que funcionan. **En Linux/WebKitGTK no hay solución conocida**, y el issue [#9220](https://github.com/tauri-apps/tauri/issues/9220) describe webview y wgpu peleándose por la superficie |
| **D · Proceso aparte** | Ventana propia con `winit` + wgpu, hablando por socket | Lo que hace Hopp. En Wayland **no se puede posicionar una ventana** respecto de otra, así que sólo sirve a pantalla completa, no para mosaicos dentro del layout |

### Qué haría

**El camino A, con `turbojpeg` y entrada planar.** Los números lo respaldan para
las dos superficies, incluida la pantalla 1080p30 que el diseño promete — y deja
el layout en HTML, que es donde vive el diseño y donde la llamada sigue estando
dentro de cac.

Antes de escribir la versión buena falta **un número**: cuánto aguanta de verdad
el transporte de Tauri con bytes crudos. Es lo único que puede tumbar A, y no se
puede medir desde fuera de la app — hay que medirlo dentro, en la pantalla de
*Webview lab* que ya existe. Con ~1,3 MB/s de JPEG no debería ser problema; con
los 89 MB/s de A′ casi seguro que sí, y por eso A va antes que A′.

`spikes/webview-probe/bench.c` mide la otra mitad —construir un `VideoFrame` y
pintarlo, contra `putImageData`, contra descodificar un JPEG— pero **está sin
correr**: abre una ventana en el escritorio de quien lo lance, y eso se avisa
antes de hacerlo.

---

## 5 · Dos errores míos, y qué los causó

**Dije que no había WebCodecs. Sí lo hay.** Busqué `JSVideoDecoder` con
`strings` y las clases se llaman `JSWebCodecsVideoDecoder`. Un nombre mal
adivinado se lee igual que una característica ausente, y sobre eso monté la
conclusión de que «el camino elegante está cerrado». De ahí sale
`spikes/webview-probe/probe.c`: preguntar en ejecución no admite ese error.

**Dije que 1080p30 estaba descartado sin necesidad de medir.** Lo estaba con el
codificador que probé —`image`, Rust puro sin vectorizar— y sobre todo con una
conversión de color que no hacía falta. Con libjpeg-turbo y entrada planar sobra
por veinte veces. El fallo de método fue tratar una implementación concreta como
si fuera el techo del problema.

Los dos tienen la misma forma: una medición barata que parecía suficiente. Y el
antídoto también: `navigator.gpu` está `undefined` aunque los símbolos `JSGPU*`
estén compilados, que es exactamente el mismo error visto del otro lado.

---

## Fuentes

- [tauri-apps/tauri #4177](https://github.com/tauri-apps/tauri/discussions/4177) —
  la memoria compartida «no está soportada ni planeada». Es de la época de la v1;
  la v2 no la añade, pero sí trae `ipc::Response` con bytes crudos y
  `register_asynchronous_uri_scheme_protocol` (comprobado en tauri 2.10.3).
- [tauri-apps #11944](https://github.com/orgs/tauri-apps/discussions/11944) —
  plugins de overlay wgpu que funcionan en Windows y macOS; para Linux/WebKitGTK
  no se menciona ninguno.
- [tauri-apps/tauri #9220](https://github.com/tauri-apps/tauri/issues/9220) —
  webview y contexto wgpu peleándose por la superficie.
- [tauri-apps/tauri #8426](https://github.com/tauri-apps/tauri/discussions/8426) —
  WebRTC en WebKitGTK **es** posible: compilando WebKit con
  `-DENABLE_WEB_RTC=ON`, con gst-plugins-bad, parcheando wry, **sólo en X11** y
  sin cubrir `getDisplayMedia`. O sea, no es una vía para distribuir a nadie.
- [gethopp/hopp](https://github.com/gethopp/hopp) — mismo stack, mismo problema.
  `core/src/livekit/video.rs` guarda I420 con strides alineados a 256 bytes para
  wgpu; `core/src/graphics/yuv_renderer.rs` y `core/src/shaders/yuv_shader.wgsl`
  lo pintan; su `core/AGENTS.md` describe el proceso aparte con `winit`.
- [Why I hate WebKit, a (non) love letter](https://www.gethopp.app/blog/hate-webkit) —
  por qué se llevan el streaming fuera de WebKit.
- [WebKitGTK 2.48](https://webkitgtk.org/2025/04/08/webkitgtk-2.48.html) —
  WebCodecs va por GStreamer y respeta `prefer-hardware` como pista.
- [livekit/rust-sdks](https://github.com/livekit/rust-sdks) — `NativeVideoStream`.
