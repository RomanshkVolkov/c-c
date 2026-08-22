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

| Puerto | Protocolo | Para qué | Estado |
|---|---|---|---|
| 7880 | TCP, vía Gateway | Señalización (WebSocket), por `rtc.guz-studio.dev` | ✓ |
| 7882 | **UDP**, directo al host | El media | ✓ verificado con tráfico real |
| 7881 | TCP, directo al host | Respaldo para redes que bloquean UDP | escucha |

**El media no pasa por Envoy**, y por eso el Gateway no aparece en esta tabla
más que para la señalización. Con `hostNetwork`, LiveKit escucha directamente en
la IP pública del VPS: MetalLB sólo reclama los puertos que tienen un Service de
tipo LoadBalancer (80, 443, 5432), así que el 7882 llega al proceso sin
intermediarios. Buscar la solución en la configuración de Envoy es el desvío
natural aquí, y no lleva a ninguna parte.

El HTTPRoute de la señalización lleva `timeouts.request: 0s`. No es opcional: el
valor por defecto de Envoy son 15 segundos y cortaría cada llamada a los quince
— la misma lección que costó la ruta de eventos, aprendida una vez y aplicada
aquí sin repetirla.

### Dos trampas que costaron una tarde, y que no se ven venir

**Kubernetes le pisa las variables a LiveKit.** Por cada Service del namespace,
Kubernetes inyecta en todos los pods una variable al estilo de los viejos
enlaces de Docker: para un Service llamado `livekit`, aparece
`LIVEKIT_PORT=tcp://10.101.6.157:7880`. Y LiveKit lee `LIVEKIT_PORT` como su
propio `--port`: intenta parsear eso como número y muere al arrancar. Dos
convenciones que no se conocen, colisionando por el nombre. Se apaga con
`enableServiceLinks: false`, que es más honesto que renombrar el Service para
esquivar una inyección que no queremos.

**`hostNetwork` no admite rolling update.** Los puertos del host son uno solo,
así que el pod nuevo no puede programarse mientras el viejo los tiene cogidos:
«didn't have free ports», y el despliegue se atasca **cada vez**. Por eso
`strategy: Recreate`. El precio son unos segundos sin voz por despliegue; con
una réplica no había alta disponibilidad que perder.

Y un tercero que no es un bug sino un eco: un pod en `CrashLoopBackOff` sigue
reportando el error **viejo** mucho después de que se haya arreglado, porque el
backoff es exponencial. Si el `describe` acusa algo que ya resolviste, compara
la edad del evento con la del arreglo antes de perseguirlo — o borra el pod y
que se recree.

### Lo que sólo se puede hacer desde fuera del repositorio

~~1. Generar el par de llaves.~~ Hecho: están en los secretos de GitHub
`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, y **nadie tiene copia** — viven ahí y
llegan al VPS por el despliegue. Si hicieran falta a mano, se regeneran y se
redespliega; no se recuperan.

~~2. La variable `LIVEKIT_URL`.~~ Hecha: `wss://rtc.guz-studio.dev`.

~~3. DNS.~~ Hecho. Un apunte: el subdominio nació **proxied** en Cloudflare
mientras `cac` es directo. Se pasó a DNS-only para igualarlos — el proxy no
transporta UDP de todas formas, así que sólo habría añadido un salto a la
señalización y sus propios tiempos de inactividad a una conexión que dura lo
que dure la llamada.

~~4. Cortafuegos.~~ No hizo falta: el media ya pasa, verificado con tráfico
real.

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
| `voice_set_deaf(enabled)` | Deja de oír: el callback del altavoz descarta lo que saca de la cola. Se descarta consumiéndolo, no saltándose el `pop` — si no, la cola crece mientras no oyes y al volver sonaría lo de hace un minuto |

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

### La pantalla, y por qué lleva dos estados y no uno

La llamada tiene sitio propio: `VoiceStage`, que ocupa el canal entero con un
mosaico por persona y la barra de mandos al pie. La cabecera del canal se queda
como puerta —«Join voice» con las caras de quien ya está dentro, «Back to call»
si estás conectado— y no como la llamada entera, que es lo que era antes.

Lo que hay que entender del store es que **conectado y mirando son dos cosas
distintas**:

| Estado | Significa |
|---|---|
| `estado !== "fuera"` | El micrófono está abierto en esa sala |
| `escenario` | La pantalla de la sala está ocupando el canal |

Con un solo booleano, minimizar cuelga. Suena a detalle y es el fallo central
del diseño anterior: pulsas «minimizar» para seguir escuchando mientras miras un
tablero y te quedas fuera de la conversación sin enterarte. Hay tests que fallan
si alguien vuelve a unirlos (`voice.test.ts`, «minimizar no cuelga»).

Mientras estás conectado con la pantalla minimizada, el pie del sidebar lleva la
barra verde con el nombre del canal, mute y colgar. Está ahí y no en la cabecera
del canal a propósito: la cabecera sólo se ve desde el canal, que es justo el
único sitio donde ya sabías que estabas conectado.

**La sordera silencia el micrófono, y quitarla no lo devuelve.** La regla vive
en el store y no en la pantalla porque es del producto: quien se ensordece en
mitad de una llamada casi siempre se está apartando de ella, y volver hablando
sin querer es el accidente que ese botón existe para evitar.

Tres cosas que el diseño pide y **todavía no están**, para que no se lean como
olvidos: la latencia en la cabecera (el motor aún no la reporta, y un número
inventado justo donde se mira cuando la llamada va mal es peor que nada), el
mute de los demás (el motor sólo reporta el propio; pintarlos a todos abiertos
miente menos que pintarlos silenciados), y el chat de la sala.

## 8 · Lo que queda, en orden

1. ~~**Infra**~~: **en pie y con el media verificado de punta a punta**
   (2026-08-22). El spike, apuntado a `wss://rtc.guz-studio.dev` desde una
   máquina de fuera, conectó, publicó un tono, y el servidor reportó
   `ActiveSpeakersChanged` con `quality: Excellent`. Eso es lo que lo demuestra:
   el SFU **detectó energía de audio**, y eso sólo pasa si los paquetes
   llegaron. No hay nada que abrir en el cortafuegos.
2. ~~**Backend**~~: hecho, ver §5.
3. ~~**Motor**~~ y ~~**UI**~~: hechos, ver §7.
4. **Probarlo entre dos máquinas de verdad** — es lo único que valida el camino
   del audio de punta a punta, y no lo puede hacer una prueba automática.
5. ~~**Quién está dentro visible sin entrar**~~: hecho.
   `GET /api/v1/chat/voice-presence` devuelve en una sola llamada quién está en
   la sala de cada espacio que el caller puede ver; la lista de canales lo pinta
   y lo refresca cada quince segundos mientras está abierta.

   **Se le pregunta al SFU en cada consulta**, sin llevar la cuenta por nuestro
   lado. Escuchar los webhooks de LiveKit y mantener el estado suena más
   eficiente y es peor: se desincroniza con el primer evento perdido y con el
   primer reinicio, y entonces la lista miente sin que nada falle. El SFU tiene
   la verdad por definición. Si algún día el volumen lo pide, la optimización es
   cachear unos segundos — no llevar un registro paralelo.

   La autorización no necesita puerta propia: los espacios salen del árbol que
   ese caller ya puede ver, así que el id de una sala ajena nunca entra en la
   consulta.
6. **Cámara y pantalla**: **publicar** está hecho para la cámara
   (`voice_set_camera`, 720p, RGB→I420 a mano porque los ayudantes del SDK dan
   un rodeo por NV12). Pistas independientes de la voz: apagar la cámara en
   mitad de una frase no corta lo que estás diciendo.

   **Ver lo que publican los demás es el problema abierto**, y no es de layout.
   Con el motor en Rust, las tramas de vídeo llegan al proceso nativo y la
   interfaz vive en un webview: hay que cruzar esa frontera treinta veces por
   segundo. El audio no tuvo este problema porque sale por los altavoces sin
   pasar por la ventana. Las salidas posibles —un esquema propio que sirva las
   tramas como un stream, o memoria compartida y un canvas— son una decisión
   arquitectónica que conviene tomar despierto, no de pasada.

7. ~~**La barra de llamada como es debido**~~: hecha. El diseño llegó
   (`docs/proposals`, descomprimido fuera del repositorio) y de él salen los
   PR 1 y 2: pantalla de la sala con minimizar, barra en el sidebar, sordera,
   presentes colgando del canal en la lista y aviso en el hilo. Ver §7.

   Quedan del mismo diseño, en orden: **cámara en los mosaicos** (bloqueada por
   el punto 6), **compartir pantalla** con su selector de fuentes, **ajustes de
   dispositivos** (micro, salida, cámara), **chat de la sala**, y el **timbre**
   —que necesita backend: `POST /task-spaces/:id/voice/ring`, su `DELETE`, y un
   evento `voice.ring` por el websocket. Sin ese evento el timbre no se puede
   entregar, y no se emula desde el cliente.

## Fuera de v1

Llamadas 1:1 en directos con timbre, TURN sobre TLS para redes hostiles,
grabación (LiveKit Egress), y cualquier fallback en navegador — rechazado a
propósito, ver §2.
