# Canales de voz: el acta del terreno

Este documento es lo que se **midió** antes de construir los canales de voz, y
por qué el diseño acabó donde acabó. Se escribe primero, y no al final, porque
la decisión más cara de este trabajo —dónde vive el motor de media— se tomó
contra hechos y conviene que el siguiente que llegue no repita el camino.

Última revisión: **2026-08-21**.

## 1 · El hallazgo que decidió el diseño

El plan natural era `livekit-client` (JS) dentro del webview: es el camino
corto, y en Windows y macOS funciona. **En Linux no existe.**

```
strings /usr/lib/libwebkit2gtk-4.1.so | grep -c JSRTCPeerConnection   → 0
strings /usr/lib/libwebkit2gtk-4.1.so | grep -c setLocalDescription   → 0
strings /usr/lib/libwebkit2gtk-4.1.so | grep -c webrtcbin             → 0
strings /usr/lib/libwebkit2gtk-4.1.so | grep -c enable-webrtc         → 1
```

El WebKitGTK de Arch/CachyOS (2.52.4) viene **compilado sin WebRTC**. La
propiedad `enable-webrtc` existe —por eso el ajuste parece aplicarse— pero
detrás no hay implementación. No es configurable, no es un permiso, y no se
arregla desde nuestro lado.

### Acta por sistema, medida en la app real

| | Windows (WebView2) | Linux (WebKitGTK 2.52) | macOS (WKWebView) |
|---|---|---|---|
| `mediaDevices` | ✓ | ✓ | ✓ |
| Micro / cámara | ✓ | ✓ **con el handler de permisos** | ✓ |
| `RTCPeerConnection` | ✓ | **✗ compilado fuera** | ✓ |
| `getDisplayMedia` | ✓ | ✗ | ✗ |

Linux se midió con `DevTools → Voice lab`, la pantalla de diagnóstico que
interroga al webview y copia esta tabla al portapapeles. Windows y macOS quedan
por medir con la misma herramienta; hasta entonces sus columnas son la
documentación de sus motores, no una medición.

### El permiso, que era un fallo aparte

Antes del handler, micro y cámara devolvían `NotAllowedError` en Linux **sin
preguntar nada**. No era el usuario denegando: WebKitGTK deniega todo permiso
que el embebedor no conteste, y Tauri no conecta esa señal. Se resuelve en
`src-tauri/src/lib.rs` (`connect_permission_request`), y se concede sin diálogo
propio porque este webview sólo carga cac — el permiso del sistema operativo
sigue aplicando por encima.

## 2 · La decisión: motor nativo

Se descartó el fallback de «abrir la sala en el navegador» a propósito: manda la
conversación fuera de la app justo cuando la tesis de cac es que el trabajo viva
dentro.

**El motor va en Rust, en el proceso de Tauri**, con el SDK nativo de LiveKit —
y para los tres sistemas, no sólo Linux. Dos stacks de media serían dos
superficies de bugs, y el nativo es además el único camino que algún día permite
compartir pantalla desde macOS.

| Pieza | Elección |
|---|---|
| SFU | LiveKit OSS, self-hosted en el VPS |
| Señalización | `wss://rtc.guz-studio.dev` → :7880, tras el Gateway que ya existe |
| Media | UDP 7882 muxeado (+ TCP 7881 de respaldo), `use_external_ip: true` |
| Token | Lo acuña el backend de cac; sala `voice:<spaceId>` derivada en el servidor |
| Cliente | `livekit` 0.8 (Rust) en el proceso Tauri; la UI manda órdenes y recibe eventos, como el pty del terminal |

## 3 · Lo que costó, medido

Spike en `spikes/voice-native/` — crate aparte a propósito: meter `livekit` en
el `Cargo.toml` de la app arrastra libwebrtc al build de todo el mundo, y eso se
mide antes de casarse.

| | |
|---|---|
| Compilación en frío (debug) | **2m 46s** |
| Compilación en frío (release) | **3m 54s** |
| Binario del spike (release, sin strip) | **36,4 MB** |
| Conectar + publicar contra LiveKit real | ✓ verificado **por el servidor** (`ListParticipants` ve la pista) |
| Cancelación de eco | ✓ **expuesta** — `AudioSourceOptions { echo_cancellation, noise_suppression, auto_gain_control }`, y un `AudioProcessingModule` completo por debajo |

Los 36 MB son del binario del spike aislado; lo que engorda la app es libwebrtc
enlazado, y ese coste se paga una vez. La cancelación de eco era el riesgo que
más pesaba —sin ella, v1 habría tenido que pedir auriculares por escrito— y
está resuelta.

**Veredicto: go.**

## 4 · Cómo se comprueba sin oídos

El spike publica un tono sintético en vez de un micrófono, y luego le pregunta
al servidor qué ve:

```
── lo que ve el servidor ──
  participante «spike-emisor» con 1 pista(s): tono-de-prueba (Audio)
```

Eso separa tres fallos que de otro modo se confunden: el SDK, la red, y el audio
del sistema. El micrófono real es el paso siguiente, y ése sí lo tiene que oír
una persona.

## 5 · Lo que queda, en orden

1. **Infra**: LiveKit en el VPS (`hostNetwork`, ConfigMap, Secret, HTTPRoute,
   abrir UDP 7882 / TCP 7881, DNS). Se verifica con dos pestañas de un navegador
   normal — separa «la infra está mal» de «el cliente está mal».
2. **Backend**: `POST /api/v1/task-spaces/{id}/voice/token`, con el guard de
   pertenencia del chat como molde.
3. **Motor**: `src-tauri/src/voice.rs` — unirse, colgar, silenciar, y eventos por
   `Channel`, con el patrón de `pty.rs` (incluida la limpieza al cerrar).
4. **UI**: entrar desde el canal, barra de conectado, y quién está dentro visible
   sin entrar.
5. **Cámara y pantalla**: nativas, después de que la voz esté sólida.

## Fuera de v1

Llamadas 1:1 en directos con timbre, TURN sobre TLS para redes hostiles,
grabación (LiveKit Egress), y cualquier fallback en navegador — rechazado a
propósito, ver §2.
