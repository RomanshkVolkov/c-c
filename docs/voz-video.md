# Cámara y pantalla: qué está resuelto y qué hay que decidir

Complemento de [`voz.md`](voz.md), que cuenta el motor de audio. Esto es sólo el
vídeo, que tiene un problema propio y una sorpresa agradable.

Lo que aquí dice **medido** se comprobó en esta máquina el 2026-08-21 y se
explica cómo, para que se pueda repetir. Lo que dice **buscado** viene de fuera
y está enlazado al final. Lo que dice **estimado** es aritmética mía y hay que
tratarlo como una hipótesis a medir, no como un dato.

---

## 1 · La sorpresa: la captura de pantalla ya está en la caja

Se planificó `scap`, `ashpd`/PipeWire y bindings de Windows Graphics Capture.
**Nada de eso hace falta.** El propio `libwebrtc` que ya enlazamos trae un
capturador de escritorio multiplataforma, y el SDK de Rust lo expone:

`libwebrtc-0.3.45/src/desktop_capturer.rs` → `DesktopCapturer`, con
`get_source_list()` (pantallas o ventanas, con título e id),
`set_include_cursor()` y un callback por trama con los píxeles.

Por sistema, y **medido** leyendo el wrapper y el binario precompilado:

| | Cómo captura | Cómo se comprobó |
|---|---|---|
| Windows | Windows Graphics Capture, con DirectX de respaldo | `set_allow_wgc_screen_capturer(true)` en `webrtc-sys-0.3.42/src/desktop_capturer.cpp:34` |
| macOS | ScreenCaptureKit, **con el selector del sistema** | `set_allow_sck_system_picker` en el mismo fichero |
| Linux | PipeWire vía xdg-desktop-portal | Ver abajo |

Lo de Linux merece detalle porque es donde esperábamos el problema. El
capturador de PipeWire sólo se activa si `WEBRTC_USE_PIPEWIRE` está definido al
compilar el wrapper, y ese define no lo pone nuestro `build.rs` sino que se lee
del binario precompilado. Las dos mitades están:

```
$ ar t .../lib/libwebrtc.a | grep -i pipewire
base_capturer_pipewire.o   screencast_portal.o   shared_screencast_stream.o …

$ head -1 .../desktop_capture.ninja | grep -o '\-DWEBRTC_USE_[A-Z_]*'
-DWEBRTC_USE_PIPEWIRE   -DWEBRTC_USE_X   -DWEBRTC_USE_GIO
```

Y `webrtc-sys-build` copia esos defines al compilar el wrapper
(`webrtc_defines()`, que lee justo esos dos `.ninja` — y el comentario del
código dice que incluye `desktop_capture.ninja` a propósito para no
desalinear la ABI de `DesktopCaptureOptions`).

**Consecuencia práctica:** compartir pantalla en Linux sale por el portal del
escritorio. Eso significa que el selector de fuentes lo pinta **el sistema**, no
nosotros — en Wayland no hay otra forma, y es lo correcto: el permiso de grabar
tu pantalla no debe concederlo una app pintando su propio diálogo. El
`ScreenPicker.tsx` de 620 px con pestañas Screens/Windows que pide el diseño
sólo tiene sentido en Windows y en macOS-sin-selector-del-sistema. Hay que
decidir si se hace el nuestro para esos dos y el del sistema en Linux, o el del
sistema en los tres.

Queda una cosa por comprobar y **no está medida**: que el enlazado real
funcione. Que los símbolos estén en el `.a` no garantiza que no falte un
`libpipewire-0.3` en tiempo de enlace, ni que el runner de CI de Ubuntu lo
tenga. Es lo primero del spike.

---

## 2 · El problema de verdad: pintar lo que llega

Publicar vídeo ya funciona (`voice_set_camera`). Lo que no hay es **ver** el de
los demás, y no es un problema de layout: el motor está en Rust y la interfaz en
un webview, y las tramas tienen que cruzar esa frontera treinta veces por
segundo. El audio nunca tuvo este problema porque sale por los altavoces sin
pasar por la ventana.

Lo que este WebKitGTK ofrece para recibirlas, **medido** con `strings` sobre
`/usr/lib/libwebkit2gtk-4.1.so` —el mismo método con el que se descubrió que no
tiene WebRTC—:

| Símbolo | ¿Está? | Qué significa |
|---|---|---|
| `JSRTCPeerConnection` | **no** | Lo que ya sabíamos: no hay WebRTC en el webview |
| `JSMediaSource` | **sí** | MSE funciona: `<video>` puede comer fMP4 troceado |
| `JSVideoDecoder`, `JSVideoFrame`, `JSWebCodecs` | **no** | **No hay WebCodecs.** Era el camino elegante y está cerrado |

Que no haya WebCodecs importa más de lo que parece: era la única vía para
mandarle al webview los fotogramas **ya codificados** que llegan de la red y que
él los descodificara. Sin eso, cualquier cosa que entre al webview tiene que
salir de una imagen ya descomprimida por libwebrtc — y hay que volver a
comprimirla. Descodificar para recodificar es el impuesto que paga este diseño.

Dos cosas que sí tenemos y que quitan dependencias de encima:

- Los codificadores están dentro del `libwebrtc` que ya enlazamos: OpenH264
  (`welsEncoderExt.o`), VP8/VP9 (`libvpx_vp8_encoder.o`) y libjpeg.
- La app ya depende de `image = "0.25"`, que trae codificador JPEG.
- Tauri es 2.10.3, que tiene las dos piezas necesarias: `ipc::Response` con
  bytes crudos —sin pasar por JSON ni base64— y
  `register_asynchronous_uri_scheme_protocol`, que permite ir devolviendo trozos
  de una respuesta en vez de una sola.

---

## 3 · Las cuatro salidas

| | Cómo | Qué cuesta | Riesgo |
|---|---|---|---|
| **A · Canvas + JPEG** | I420 → JPEG en Rust → bytes crudos por `Channel` → `createImageBitmap` → `<canvas>` | Un JPEG por trama y por persona | CPU. Sube con los píxeles al cuadrado |
| **B · `<video>` + fMP4** | I420 → H.264 (OpenH264) → fMP4 → protocolo propio → MSE | Un codificador y un muxer que hay que escribir | El muxer fMP4 a mano es donde se va el tiempo |
| **C · Superficie nativa** | Las tramas no entran al webview: se pintan con wgpu en una superficie propia, debajo o encima | Un renderer y un shader YUV→RGB | **En Linux/WebKitGTK no hay solución conocida** (buscado) |
| **D · Proceso aparte** | Ventana propia con `winit` + wgpu, hablando por socket con la app | Lo de C más un proceso y su IPC | La llamada deja de estar dentro de la app |

Aritmética de servilleta para saber de qué orden hablamos (**estimado**, no
medido — el propósito es descartar, no decidir):

- Un mosaico de cámara en la rejilla ronda 640×360. En I420 crudo son 346 kB por
  trama; tres personas a 15 fps son ~15 MB/s de copia. En JPEG rondaría 30 kB, o
  sea ~1,4 MB/s. Barato.
- Una pantalla compartida a 1080p30 en crudo son 3,1 MB por trama: **93 MB/s**.
  Descartado sin necesidad de medir nada. En JPEG bajaría a unos 6 MB/s de
  datos, pero son treinta codificaciones de 1080p por segundo, y ahí es donde el
  codificador **puro Rust** del crate `image` probablemente no llegue.

Es decir: **cámara y pantalla no tienen el mismo presupuesto**, y lo que
funciona para una puede no funcionar para la otra. Esa es la conclusión útil de
esta sección.

---

## 4 · Alguien ya se comió este problema

[Hopp](https://github.com/gethopp/hopp) es OSS, hace pair programming remoto, y
tiene **exactamente nuestro stack**: Tauri, Rust, LiveKit, y el mismo tropiezo
con WebKitGTK sin WebRTC. Su código dice lo que eligieron:

- `core/src/livekit/video.rs` guarda el I420 en un doble búfer con los *strides*
  alineados a 256 bytes — que es justo lo que exige wgpu para `bytes_per_row`.
  La trama nace lista para la GPU y nunca se copia a un búfer intermedio.
- `core/src/graphics/yuv_renderer.rs` y `core/src/shaders/yuv_shader.wgsl` la
  pintan con un shader que hace YUV→RGB en la tarjeta.
- Su `core/AGENTS.md` describe la arquitectura: un **proceso aparte** lanzado por
  la app de Tauri, que habla por socket Unix (TCP en Windows) y tiene su propio
  bucle de `winit`.

O sea, la salida **D**. Y su blog lo dice sin rodeos: se están llevando las
ventanas de streaming fuera de WebKit para centralizar la lógica en el backend
«y no repartida entre Rust y ventanas de WebKit».

No es una prueba de que D sea lo correcto para nosotros —ellos comparten una
pantalla a pantalla completa y nosotros queremos mosaicos dentro de una interfaz
que ya existe— pero sí es la prueba de que el camino corto no les valió.

---

## 5 · Lo que yo haría

**Separar las dos superficies y medir antes de comprometerse.**

1. **Un spike, tres números.** Con el mismo patrón que el spike de voz: coger
   tramas I420 reales, y medir (a) cuánto tarda un JPEG de 640×360 y otro de
   1080p con el crate `image`, (b) cuánto aguanta el `Channel` de bytes crudos de
   Tauri, y (c) si `DesktopCapturer` enlaza y captura en esta máquina Wayland.
   Sin esos tres números, elegir entre A y C es una apuesta.
2. **Cámara por el camino A si los números dan.** Los mosaicos son pequeños y el
   layout es HTML, que es donde vive el diseño. Meter una superficie nativa por
   cuatro caras de 640×360 es traer toda la complejidad de C para el caso barato.
3. **Pantalla compartida: es donde A se rompe.** Si el spike lo confirma, hay dos
   respuestas honestas antes de escribir un segundo renderer: **bajar lo que
   prometemos** —720p a 15 fps se lee un editor de código perfectamente, y es
   mucho menos de la mitad del trabajo— o irse a C/D. Conviene decidirlo sabiendo
   que la píldora «1080p 30fps» del diseño es una promesa que nadie ha medido.
4. **C antes que D.** El proceso aparte es lo que hace Hopp y resuelve, pero
   parte la app en dos y se lleva por delante «la conversación vive dentro de
   cac», que es la tesis del producto. Sólo si C no se puede en Linux —y hoy
   **buscado** no hay solución conocida ahí— tiene sentido pagar D.

Lo que **no** haría es empezar por B. El muxer fMP4 a mano es el trabajo más
largo de los cuatro, y su única ventaja —que el `<video>` descodifique por
hardware— se la come el haber tenido que codificar en H.264 justo antes.

---

## Fuentes

- [tauri-apps/tauri #4177 — pasar un frame buffer al webview](https://github.com/tauri-apps/tauri/discussions/4177):
  la memoria compartida «no está soportada ni planeada» por diseño. Es de la
  época de la v1; la v2 no la añade, pero sí trae bytes crudos y protocolos
  asíncronos.
- [tauri-apps #11944 — pintar wgpu como overlay del webview](https://github.com/orgs/tauri-apps/discussions/11944):
  hay plugins que funcionan en Windows y macOS; **para Linux/WebKitGTK no se
  menciona ninguna solución**.
- [tauri-apps/tauri #9220](https://github.com/tauri-apps/tauri/issues/9220):
  webview y contexto wgpu «se pelean» por la superficie y parpadea.
- [gethopp/hopp](https://github.com/gethopp/hopp) — el código citado arriba.
- [Why I hate WebKit, a (non) love letter](https://www.gethopp.app/blog/hate-webkit) —
  su relato de por qué se llevan el streaming fuera de WebKit.
- [Lessons learned building a sub-100ms remote control app with Rust and LiveKit](https://news.ycombinator.com/item?id=43483501) —
  por qué eligieron nativo: acceso a las APIs del sistema y poder parchear
  libwebrtc.
- [livekit/rust-sdks](https://github.com/livekit/rust-sdks) — `NativeVideoStream`
  es la vía para recibir las tramas.
