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

## 5 · La puerta: el token

`POST /api/v1/task-spaces/{id}/voice/token` → `{url, token, room}`.

Dos reglas, y las dos tienen test con mutación que las tumba:

1. **La sala se deriva del espacio en el servidor** (`service.RoomFor` →
   `voice:<spaceId>`), nunca se acepta del cliente. Si viajara en la petición, el
   guard estaría comprobando la pertenencia a un espacio mientras el token
   concede la entrada a otro.
2. **La pertenencia decide**, con el mismo `resolveSpace` que el chat de ese
   espacio: hablar y escribir en un canal son el mismo permiso. Pedir la sala de
   otra organización devuelve **404**, no 403 — confirmar que el espacio existe
   ya sería contar algo.

El token concede entrar, publicar y suscribirse. **No** concede administrar la
sala: echar gente o cambiar metadatos no es algo que un cliente deba poder
hacer, y darlo «por si acaso» es repartir permisos que nadie pidió. Dura una
hora; reconectar pide otro.

Sin `LIVEKIT_*` configurado el endpoint contesta **501** con «voice-unconfigured»
en vez de acuñar un token que ningún servidor aceptaría: una instalación sin voz
es legítima y la pantalla puede decirlo con esas palabras.

## 6 · Puertos, y qué hay que abrir a mano

| Puerto | Protocolo | Para qué |
|---|---|---|
| 7880 | TCP, vía Gateway | Señalización (WebSocket). Sale por `rtc.guz-studio.dev` |
| 7882 | **UDP** | El media. Es el que hay que abrir en el security group |
| 7881 | TCP | Respaldo para redes que bloquean UDP |

El HTTPRoute de la señalización lleva `timeouts.request: 0s`. No es opcional: el
valor por defecto de Envoy son 15 segundos y cortaría cada llamada a los quince
— la misma lección que costó la ruta de eventos, aprendida una vez y aplicada
aquí sin repetirla.

### Lo que sólo se puede hacer desde fuera del repositorio

1. Generar el par de llaves: `docker run --rm livekit/livekit-server generate-keys`.
2. Guardarlas como secretos de GitHub `LIVEKIT_API_KEY` y `LIVEKIT_API_SECRET`,
   y la variable `LIVEKIT_URL` con `wss://rtc.guz-studio.dev`.
3. DNS: `rtc.guz-studio.dev` → la IP del VPS.
4. Security group: abrir **UDP 7882** y TCP 7881.

El despliegue omite el secreto de LiveKit si no hay llaves, así que **un deploy
sin nada de esto no falla**: simplemente no hay voz, y el endpoint lo dice.

## 7 · El motor, dentro del proceso

`src-tauri/src/voice.rs`, con la forma de `pty.rs`: comandos que la pantalla
invoca, eventos que suben por un `Channel`, y limpieza al cerrar la ventana
—una sala abierta y un micrófono vivo en un proceso que ya nadie mira es peor
que un recurso filtrado—.

| Comando | Qué hace |
|---|---|
| `voice_join(url, token, onEvent)` | Conecta, publica el micro, devuelve tu identidad |
| `voice_leave()` | Sale. Idempotente |
| `voice_set_mic(enabled)` | Silencia **en la fuente**, sin parar el dispositivo: volver a hablar es inmediato en vez de tener que levantar otra vez el audio |

**Aquí no hay credenciales de cac.** La pantalla pide el token al backend y le
pasa al motor un `{url, token}` ya concedido — este código no puede entrar donde
no le dejaron entrar. Esa separación es lo que hace que la autorización de la voz
sea exactamente la del resto de la app.

Dos detalles del audio que no son adorno:

- **Acumulador de 10 ms.** cpal entrega tramas del tamaño que le da la gana y
  libwebrtc las quiere de 10 ms exactos. Sin el acumulador de por medio, la voz
  sale troceada.
- **AEC encendido** (`echo_cancellation`, `noise_suppression`,
  `auto_gain_control`). Sin él, hablar con altavoces es un bucle de
  realimentación. Que el SDK lo exponga fue lo primero que comprobó el spike.

La UI vive en la cabecera del canal, no en una pantalla aparte: la conversación
hablada es del canal. Al entrar, el mismo sitio pasa a ser la barra de la
llamada, con un punto por persona que se enciende cuando habla.

## 8 · Lo que queda, en orden

1. ~~**Infra**~~: manifiestos escritos (`backend/k8s/5-livekit.yaml`,
   `6-livekit-route.yaml`) y enganchados al despliegue. **Pendiente**: los cuatro
   pasos de §6.2 que viven fuera del repositorio. Se verificará con dos pestañas
   de un navegador normal — eso separa «la infra está mal» de «el cliente está
   mal».
2. ~~**Backend**~~: hecho, ver §5.
3. ~~**Motor**~~ y ~~**UI**~~: hechos, ver §7.
4. **Probarlo entre dos máquinas de verdad** — es lo único que valida el camino
   del audio de punta a punta, y no lo puede hacer una prueba automática.
5. **Quién está dentro visible sin entrar**: hoy sólo se ve estando dentro. Pide
   que el servidor publique la ocupación de cada sala (webhooks de LiveKit o
   consulta periódica), y es lo siguiente.
6. **Cámara y pantalla**: nativas, después de que la voz esté sólida.

## Fuera de v1

Llamadas 1:1 en directos con timbre, TURN sobre TLS para redes hostiles,
grabación (LiveKit Egress), y cualquier fallback en navegador — rechazado a
propósito, ver §2.
