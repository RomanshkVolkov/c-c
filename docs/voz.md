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
| `voice_set_mic(enabled)` | Silencia **la pista publicada**, no sólo las muestras — ver abajo. La captura sigue corriendo: volver a hablar es inmediato en vez de tener que levantar otra vez el dispositivo |
| `voice_list_devices()` | Qué micrófonos y qué cámaras hay, y cuál está puesto. Se pregunta al abrir el desplegable y no al entrar a la sala: enchufar unos auriculares en mitad de una llamada es justo cuando alguien lo abre |
| `voice_set_device(kind, deviceId)` | Cambia de micrófono **sin cortar la voz** —se levanta la captura nueva y luego se suelta la vieja, y la pista publicada es la misma— o de cámara, que sí parpadea porque su pista está atada al dispositivo |
| `voice_set_deaf(enabled)` | Deja de oír: el callback del altavoz descarta lo que saca de la cola. Se descarta consumiéndolo, no saltándose el `pop` — si no, la cola crece mientras no oyes y al volver sonaría lo de hace un minuto |

**Aquí no hay credenciales de cac.** La pantalla pide el token al backend y le
pasa al motor un `{url, token}` ya concedido — este código no puede entrar donde
no le dejaron entrar. Esa separación es lo que hace que la autorización de la voz
sea exactamente la del resto de la app.

**La preferencia de dispositivo sobrevive a la llamada.** Quien tuvo que
corregir el micrófono una vez no debería tener que corregirlo en cada sala, así
que vive fuera de la sesión. El micrófono se guarda por el `DeviceId` de cpal
—que la biblioteca documenta como estable entre desconexiones y reinicios— y la
cámara por nombre, porque `nokhwa` sólo da índice y nombre y el índice se mueve
al enchufar otro cacharro. Si el guardado ya no existe, se cae al del sistema:
negarse a hablar porque falta un micrófono concreto sería peor.

**En Linux hay que filtrar la lista, y no es opcional.** cpal enumera la
configuración de ALSA entera: en un portátil con PipeWire salen quince entradas
de las que **una** es hardware. El resto son plugins —conversores de tasa,
mezcla a 4/6/8 canales, puentes a JACK y a OSS— con nombres que suenan a
dispositivo: «Rate Converter Plugin Using Libav», «PulseAudio Sound Server»,
«Plugin for channel upmix (4,6,8)». Y el mismo códec aparece ocho veces con la
misma descripción, porque son subdispositivos.

Se filtra por el **nombre PCM** (`DeviceId::id()`, lo mismo que imprime
`arecord -L`) y no por la descripción, que cambia con el idioma y con la
versión. Es una lista de permitidos y no de prohibidos —los plugins de ALSA se
inventan nuevos, el hardware no cambia de forma de nombrarse— y **nunca filtra
hasta dejarla vacía**: si no sobrevive nada se enseña entera, porque una lista
fea es mejor que ninguna cuando alguien tiene el micrófono equivocado.

**Falta elegir la salida**, y no se pinta hasta que se pueda: cambiarla obliga a
reconstruir el stream de reproducción de cada pista remota a la vez, y es la que
menos se equivoca de las tres.

### Los comandos que tocan el SDK van `async`. Siempre

`voice_set_mic` fue síncrono una versión y **cerraba la app al silenciarse**, en
Windows y en Linux. La cadena es corta y no se ve venir: Tauri corre los
comandos síncronos en el hilo principal, que no está dentro de ningún runtime
de Tokio; `LocalAudioTrack::mute()` avisa al servidor con un
`tokio::task::spawn`; y `tokio::task::spawn` entra en pánico fuera de un
runtime. Un pánico en el hilo principal se lleva el proceso.

`voice_set_camera` era `async` desde el principio y por eso nunca falló — lo que
hizo el fallo más difícil de ver, porque la cámara y el micrófono parecían
hacer lo mismo.

No hay prueba de unidad que llegue ahí: hace falta una llamada abierta y alguien
pulsando. Lo que sí hay es un test que **lee el propio fichero** y exige que
todo `#[tauri::command]` sea `async`, con una lista de excepciones que hay que
escribir a mano. Que haya que nombrarlas convierte «se me olvidó» en «decidí que
éste puede».

**Silenciarse tiene que viajar.** La primera versión zereaba las muestras y ya:
te dejaba callado, pero para el resto de la sala seguías con el micrófono
abierto —el SFU no distingue tu silencio del silencio— y su icono de «mudo»
nunca se encendía. `LocalAudioTrack::mute()` sí viaja: el servidor lo reparte y
a los demás les llega un `TrackMuted`. Las muestras se siguen zereando encima,
que es lo que garantiza que entre pulsar y que el servidor se entere no salga
media palabra.

**Los que ya estaban.** El SDK **no** manda `ParticipantConnected` por la gente
que estaba en la sala antes que tú: vienen en `RoomEvent::Connected` con sus
publicaciones. Sin ese brazo, entrar a una conversación en curso enseñaba una
sala vacía hasta que alguien se movía — justo la vez que más importa ver quién
hay. De ahí sale también su estado de micrófono de partida: reportarlo sólo al
cambiar dejaba a quien entró mudo pintado como abierto hasta que hablara.

**La latencia es medida, no estimada.** Sale de `Room::get_stats()`, del
`CandidatePair` **nominado** —el camino por el que van de verdad los paquetes— y
su `current_round_trip_time`, que es lo que mide WebRTC con sus consent checks.
Hay un par por cada camino que ICE probó y casi todos son callejones con el
contador a cero; coger el primero de la lista da un número bonito que no
corresponde a nada, y hay tests en `voice.rs` que fallan si alguien lo hace. Se
pregunta cada cinco segundos y, mientras no haya par nominado, **no se manda
nada**: un «0 ms» en la cabecera se lee como una conexión perfecta justo cuando
todavía se está estableciendo.

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

### El timbre

Un canal de voz al que hay que mirar para enterarte de que alguien te espera no
es una llamada: es un sitio. El timbre es lo que convierte «estoy en el canal»
en «te estoy llamando».

**No se guarda en ninguna parte.** Es un evento y no un registro: lo único que
hace es hacer sonar un teléfono, y un teléfono que suena no es estado que haya
que reconciliar. Guardarlo obligaría a limpiarlo —al colgar, al expirar, al
reiniciar un pod— y cada una de esas limpiezas es una manera nueva de dejar un
timbre sonando para siempre. El tope de **veinte segundos** viaja en
`expiresAt` y lo respetan los dos clientes por su cuenta; por eso un timbre deja
de sonar aunque la app de quien llamaba muera de golpe.

| Endpoint | Qué hace |
|---|---|
| `POST /api/v1/task-spaces/{id}/voice/ring` `{userId}` | Hace sonar a esa persona. Devuelve `{ringId, expiresAt}` |
| `DELETE /api/v1/task-spaces/{id}/voice/ring/{userId}` | Deja de llamarla |

La cancelación va **por persona y no por `ringId`**, que es donde el diseño
original y la realidad no coincidían: sin estado en el servidor, un id opaco no
dice a quién había que avisar de la cancelación —habría que guardar la
correspondencia, que es justo lo que se evita—. «Deja de llamar a esta persona»
es además idempotente, que es lo que uno quiere de un botón de colgar.

Ese mismo endpoint es el que usa **rechazar**: quien recibe la llamada cancela
el timbre hacia quien llamaba, y a este le llega como una cancelación con el id
del otro. Así un «no» se ve al instante en vez de a los veinte segundos, sin
inventar un endpoint más.

La entrega **no es por websocket** como decía el handoff, sino por el stream SSE
que ya existe, con `Event.UserID`: el hub sabe dirigir un evento a una persona
—lo hacía ya para los directos— y eso es lo que hace que el teléfono suene en un
solo escritorio. Si saliera dirigido a la organización sonaría en todo el equipo
y nadie sabría a quién llamaban; hay un test que lo vigila
(`voice_ring_test.go`, «suena en un solo escritorio»).

Los tonos son **WebAudio sintetizado**, sin ficheros: dos senos y una
envolvente pesan cero en el instalador y no hay que empaquetar un mp3 para tres
sistemas operativos. La rampa de 30 ms a la entrada y a la salida no es estética
—cortar una onda en seco suena a chasquido, y un chasquido cada 1,6 segundos es
peor que el timbre—. El tono entrante respeta la sordera; el silencio del
sistema operativo no lo puede consultar un webview, así que eso queda sin hacer
y sin fingir.

Del diseño falta todavía el **chat de la sala**. El mute de los demás y la
latencia ya los reporta el motor (arriba); el propio micrófono se pinta de forma
optimista al pulsar y el evento del servidor confirma un instante después,
porque esperar la confirmación son doscientos milisegundos en los que parece que
el botón no hizo nada.

En el store, `mudos` es un **mapa** y no una lista de silenciados a propósito:
«no sé nada de esta persona» y «esta persona está abierta» no son lo mismo, y
pintar mudo a quien no ha reportado su pista es peor que no pintar nada — te
callas creyendo que el otro no te oye.

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

   **No funcionó hasta la v1.6.40**, y los dos fallos eran del mismo tipo: creer
   saber qué contesta un servidor que no controlamos.

   1. La API Twirp de LiveKit emite los nombres del proto **en snake_case**.
      Leíamos `numParticipants` y llega `num_participants`, así que el recuento
      era siempre cero, toda sala parecía vacía y se saltaban todas.
   2. `ListParticipants` mira dentro de una sala concreta y **exige que el token
      la nombre**. `RoomAdmin` a secas vale para listar salas y no para mirar
      dentro de una: 401.

   Y lo que los hizo invisibles: un `continue` tolerante —«una sala que no se
   deja leer no tumba las demás»— convirtió un fallo permanente de permisos en
   algo que se veía igual que una sala vacía. Ahora se registra.

   Había un test que debería haberlo cazado y no pudo: su servidor falso estaba
   escrito **copiando nuestra propia struct** en vez de una respuesta real, así
   que comprobaba que el código se parece a sí mismo. Los dobles de
   `voice_test.go` llevan ahora las claves del servidor de verdad, y hay un test
   nuevo con una respuesta capturada de un LiveKit en marcha.

   **Se le pregunta al SFU en cada consulta**, sin llevar la cuenta por nuestro
   lado. Escuchar los webhooks de LiveKit y mantener el estado suena más
   eficiente y es peor: se desincroniza con el primer evento perdido y con el
   primer reinicio, y entonces la lista miente sin que nada falle. El SFU tiene
   la verdad por definición. Si algún día el volumen lo pide, la optimización es
   cachear unos segundos — no llevar un registro paralelo.

   La autorización no necesita puerta propia: los espacios salen del árbol que
   ese caller ya puede ver, así que el id de una sala ajena nunca entra en la
   consulta.
6. ~~**Ver el vídeo de los demás**~~: hecho, y con el análisis medido en
   [`voz-video.md`](voz-video.md). Las tramas no cruzan por el canal de IPC:
   Rust guarda la última de cada participante y la sirve comprimida bajo el
   esquema `cacvideo://`, y **se comprime cuando la pantalla la pide**, no
   cuando llega. Una cámara cuyo mosaico nadie mira no cuesta un ciclo.

   **La v1.6.38 colgó la app por esto y conviene saber por qué.** El manejador
   del esquema era *síncrono*, y un manejador síncrono corre en el hilo que
   atiende al webview: once milisegundos de JPEG por trama, decenas de veces
   por segundo, y la ventana deja de responder. Encima el bucle del lienzo no
   tenía tope y pedía todo lo rápido que la máquina daba, recomprimiendo la
   misma trama. Ahora se contesta desde otro hilo, cada trama lleva número de
   secuencia —quien ya la tiene recibe un 204 y no se comprime nada— y el
   lienzo tiene un techo de 30 peticiones por segundo.

   Falta por medir el transporte con esos arreglos puestos, y eso sólo se ve
   con dos máquinas hablando.

   **Tu propio recuadro no sale de la lista del servidor.** `ActiveSpeakersChanged`
   la decide el SFU, tarda su medio segundo y puede no incluirte; en la v1.6.38
   el recuadro propio no se encendía nunca. Se mide ahora sobre las mismas
   muestras que se publican —energía RMS por trama de 10 ms, con 300 ms de cola
   para que no parpadee entre sílabas— y es inmediato, funciona estando solo en
   la sala, y se apaga solo al silenciarse porque las muestras ya van a cero.
   Un golpe fuerte cerca del micro lo enciende un instante: está medido, está
   aceptado, y hay un test que lo dice para que nadie lo tome por un fallo.

7. ~~**Compartir pantalla**~~: hecho, con el `DesktopCapturer` que ya venía en
   libwebrtc — WGC en Windows, ScreenCaptureKit en macOS, PipeWire en Linux.
   Ver `docs/voz-video.md` §1.

   **El selector de fuentes lo pinta el sistema y no nosotros.** En Linux la
   captura pasa por xdg-desktop-portal, que enseña su propio diálogo; en macOS,
   ScreenCaptureKit trae el suyo. No es una limitación que estemos rodeando: el
   permiso de grabar tu pantalla no debe concederlo una aplicación dibujando su
   propia ventana. Por eso `voice_share_screen` no recibe una fuente y no existe
   `voice_list_sources`. En Windows sí se podría enumerar y elegir dentro de la
   app, y ahí queda — un selector propio en un sistema y el del sistema en los
   otros dos es peor de explicar que un solo camino.

   **Se espera a la primera trama antes de publicar.** Es lo único que demuestra
   que el sistema concedió el permiso, y es lo que permite crear la pista con el
   tamaño de verdad en vez de adivinarlo. Publicar antes deja a los demás
   mirando un rectángulo negro mientras alguien decide en el diálogo.

   Dos detalles que muerden: el capturador entrega **BGRA** y no RGB como la
   cámara —confundirlo pinta a todo el mundo de azul— y hay que pedirle tramas
   **a ritmo de vídeo**, nunca en bucle cerrado: a un millón de peticiones por
   segundo no deja trabajar al hilo que las produce y contesta «todavía no»
   para siempre. Eso costó una tarde en el spike.

8. **Un fallo del motor que no se ve es un fallo que dura.** Tres versiones se
   probaron a ciegas —«no se ve nada», «encender la cámara no hace nada»— y en
   las tres el motor sabía perfectamente qué había pasado. Dos cosas lo
   arreglan, y las dos son de método más que de código:

   - **Los errores se pintan donde está el control.** `alternarCam` dejaba el
     mensaje en `voice.store.error` y el escenario no lo pintaba en ninguna
     parte, así que un fallo del motor se veía **exactamente igual** que un
     botón que no responde. Ahora sale junto a la barra de mandos.
   - **El motor lleva un diario** (`nota()` en `voice.rs`): trescientas líneas
     con marca de tiempo, en los **cambios de estado** y nunca por trama —
     entrar, salir, silenciar, qué formato de cámara se pidió y cuál abrió, si
     el portal concedió la pantalla, qué pistas llegan. Se lee en
     *Dev tools → Voice lab* y se copia con un botón, para pegarlo en un
     reporte. Una línea por trama sería un cuello de botella y un diario que
     nadie lee.

9. **Una webcam son dos dispositivos, y `nokhwa` devuelve el muerto primero.**
   Medido con `spikes/camera-probe` en la máquina donde fallaba:

   ```text
   index=Index(1)  nombre="HD Webcam: HD Webcam"  formatos=0   ← no abre nunca
   index=Index(0)  nombre="HD Webcam: HD Webcam"  formatos=10  ← 10/10 tramas
   ```

   El segundo nodo es el de metadatos que acompaña a muchas webcams: **se llama
   igual** y `nokhwa::query` lo devuelve **antes**. El selector de dispositivos
   deduplica por nombre y se quedaba con él; la preferencia guardada lo buscaba
   por nombre y encontraba el mismo. La cámara «se abría» donde no hay imagen.

   Se filtra por «¿ofrece algún formato?», que es lo único que los distingue —
   no por una lista de índices o de nombres sospechosos, que envejecería. Cuesta
   abrir cada dispositivo un instante, y se paga al listar o al elegir, nunca
   por trama.

   La primera trama tarda **~590 ms** (1280×720 MJPEG); las siguientes, ~33 ms.
   El plazo de veinte segundos sobra de largo, que descarta la otra sospecha.

10. **Un bucle de captura que se rinde tiene que decir por qué.** El de la
    cámara hacía `let Ok(t) = camara.frame() else { break }`: el primer error
    rompía el bucle, el hilo terminaba sin avisar y el llamante sólo veía
    agotarse su plazo. «La cámara no entregó ninguna imagen» era todo lo que
    quedaba de un error que el driver sí había explicado.

    Ahora un tropiezo no mata la captura —treinta seguidos, sí— y al salir
    **antes** de la primera trama se manda el motivo real por el mismo canal
    que la respuesta buena. Un plazo agotado no es un diagnóstico: es la
    ausencia de uno.

11. **La ruta del vídeo llega escapada, y eso dejó sin imagen a las dos
    capturas.** `convertFileSrc` de Tauri pasa la ruta entera por
    `encodeURIComponent`, **barras incluidas**. En cuanto la URL pasó a tener
    dos segmentos —`<identidad>/<fuente>`— la barra viajaba como `%2F`, el
    manejador buscaba a una persona llamada «u-ana%2Fcamera» y contestaba 404 a
    todo.

    Ni la cámara ni la pantalla se veían nunca. Como son dos capturas
    completamente distintas, parecían dos fallos independientes y se
    persiguieron por separado durante tres versiones. Lo que las unía era el
    único trozo que compartían.

    `media.rs` ya tenía su propio `percent_decode` por esto mismo, con el motivo
    escrito encima. La lección no es «hay que decodificar»: es que **cuando dos
    cosas que no se parecen fallan igual, lo que falla es lo que comparten** — y
    yo estaba mirando los dos extremos.

12. **No era la cámara: era crear la pista.** La cámara abría, entregaba su
    primera trama cruda y el diario se paraba en «descodificando» para siempre.
    Cinco versiones persiguiendo a `Camera::frame()` y a `MmapStream::next()`,
    que bloquea sin plazo y era el sospechoso perfecto. No era.

    `NativeVideoSource::new` **no es una función de construcción a secas**:
    dentro arranca un mantenedor de tramas negras con `livekit_runtime::spawn`,
    que con la característica `tokio` es `tokio::task::spawn` a pelo. Nuestros
    bucles de captura son `std::thread::spawn` sin runtime, así que la llamada
    entraba en pánico —«there is no reactor running»— y el hilo moría en el
    sitio. La pantalla caía por lo mismo: «pidiendo permiso» y después nada.

    Es **el mismo fallo que cerró la app al silenciarse** (punto 8), un piso más
    abajo: allí un comando síncrono en el hilo principal, aquí un hilo nuestro.
    La regla que faltaba: *cualquier* llamada al SDK necesita runtime, la firma
    sea `async` o no. Arreglado con `entrar_al_runtime()` al principio de los
    dos hilos —el contexto de Tokio es **por hilo**, no por proceso: entrar en
    `main` no sirve—.

    Lo que hizo que costara tanto fue el disimulo, y ahí hay tres lecciones
    aparte del arreglo:

    - **El pánico se desenrolla y ejecuta los `Drop`.** El testigo que bajaba
      `CAPTURA_VIVA` al salir del hilo hacía justo su trabajo, y con eso la
      guardia contra dos capturas simultáneas daba paso libre al siguiente
      intento. Una protección puesta contra un cuelgue no protege de una muerte.
    - **`Disconnected` no es `Timeout`.** Al morir el hilo se cerraba el canal y
      el llamante lo contaba como plazo agotado: «la cámara no entregó ninguna
      imagen» —verdad literal, diagnóstico nulo—. Ahora se distinguen, porque
      un hilo muerto y un hilo lento piden mirar en sitios distintos.
    - **Un vigía sólo puede señalar la última marca, no la llamada culpable.**
      Marcaba «descodificando» antes de descodificar, y entre esa marca y la
      siguiente había *dos* llamadas: la que sospechábamos y la que fallaba.
      `spikes/camera-probe` daba 10/10 tramas porque copiaba la primera y no la
      segunda — el spike reprodujo fielmente la parte inocente.

    Reproducido en `spikes/voice-native/src/bin/fuente.rs`: desde un hilo suelto
    muere, entrando al runtime desde ese mismo hilo funciona. Dos pruebas lo
    sujetan: una lee este fichero y exige que toda función que cree una
    `NativeVideoSource` llame a `entrar_al_runtime`, y otra comprueba que el
    pánico del SDK sigue siendo real — si algún día deja de serlo, cae y la
    precaución sobra.

13. **La resolución la dice la cámara, no nosotros.** Se abría pidiendo «el
   formato con más fps» —que podía ser 320×240— y luego el bucle **descartaba
   toda trama que no fuera exactamente 1280×720**. Con una webcam que diera otra
   cosa, el botón se quedaba encendido y no se publicaba una sola imagen, sin un
   error en ninguna parte. Ahora se pide la mayor que no pase de 720p, se acepta
   lo que entregue, y la pista se crea con **sus** medidas; si cambia a media
   captura, la fuente se rehace en vez de tirar tramas.

   El comentario que había encima decía «sólo si la cámara entrega justo lo que
   pedimos». La suposición estaba escrita y nadie la comprobó.

   **Y el arreglo tuvo su propia versión rota**, que es la parte instructiva:
   se pasó a pedir `HighestResolution(1280×720)` creyendo que era «la mayor que
   no pase de 720p». No lo es — `nokhwa-core-0.1.9/src/types.rs:115` filtra por
   **igualdad exacta** y devuelve `None` si no la encuentra, con lo que
   `Camera::new` falla y la cámara ni se abre. Se cambió una webcam mal
   configurada por ninguna cámara. `Closest` tampoco sirve: elige la resolución
   más cercana y luego busca los fps de la **pedida**.

   Ahora es una **cadena con caída** —720p, 480p, la de más fps, la mayor— y se
   queda con la primera que abra. Las dos últimas aceptan lo que la cámara
   prefiera: pueden dar algo pequeño o enorme, pero abren, y el bucle publica
   con las medidas que lleguen. Cada intento se anota en el diario.

14. **Te ves a ti mismo, y no es un adorno.** El motor no se suscribe a sus
   propias pistas —el SFU no te devuelve lo que acabas de mandar— así que tu
   cámara y tu pantalla no llegarían nunca por el camino de los demás. La
   captura las guarda por su cuenta en el mismo sitio, bajo tu propia identidad.

   Sin esto, encender la cámara sin nadie más en la sala no enseñaba nada y
   parecía rota; y **no había forma de comprobar que compartir pantalla
   funciona sin dos máquinas**, que fue exactamente lo que pasó al probar la
   v1.6.41. Cuesta una copia por trama, la misma que se paga por cada
   participante remoto.

   Tu cara va **en espejo** y tu pantalla no: levantar la mano derecha tiene
   que mover el lado derecho de la imagen, y una pantalla volteada sale con el
   texto del revés.

15. **Lo que salió de revisar el camino caliente**, y que ninguna prueba podía
    cazar porque todo pasa a treinta veces por segundo con una llamada abierta:

    - **Las respuestas vacías no llevaban CORS.** El 204 «no ha cambiado» es la
      más frecuente de las tres, y en Windows el esquema es otro origen: sin
      `Access-Control-Allow-Origin`, el `fetch` falla en vez de contestar, el
      lienzo lo toma por un error de red y espera. El vídeo en Windows habría
      ido a tirones o no habría arrancado.
    - **Colgar no paraba las capturas.** `CAMARA` y `PANTALLA` son la única
      correa de esos hilos, y no se bajaban al salir. Seguían pidiendo tramas y
      convirtiendo espacios de color para siempre — y como `voice_join` cuelga
      antes de entrar, dos salas seguidas dejaban dos cámaras corriendo.
    - **Cada petición clonaba la trama entera** para soltar el candado antes de
      comprimir: tres megabytes por vuelta en 1080p. Ahora los planos van en un
      `Arc` y el candado se suelta igual de pronto sin copiar la imagen.
    - **Un hilo nuevo por petición.** Treinta por segundo y por mosaico, cada
      uno costando más que el trabajo que hacía. Va al pool de hilos
      bloqueantes, que además hace que el búfer reutilizable del entrelazado
      sirva de algo: con un hilo distinto cada vez no se reutilizaba nunca.

16. **La cara y la pantalla son dos cosas distintas, en todo el camino.** Las
   tramas se guardan por `(persona, fuente)` y se piden a
   `cacvideo://…/<identidad>/<camera|screen>`. Estuvieron guardándose sólo por
   persona: nadie lo notó porque no había pantalla que compartir, y en cuanto la
   hubiera, el mosaico habría parpadeado entre la cara y la pantalla treinta
   veces por segundo.

   En el escenario, una pantalla compartida **ocupa el sitio** y las caras se
   van a una tira lateral: es lo que se ha venido a mirar, y en un mosaico de la
   rejilla no se lee. Se pinta con `object-contain` y no `object-cover` — a una
   cara se le recorta el borde sin perder nada, a una pantalla se le corta justo
   lo que alguien quería enseñar.

   Si dos comparten a la vez, **manda el primero**. Cambiar el foco solo porque
   alguien más empezó a compartir es quitarle de delante a la gente lo que
   estaba leyendo.

17. **Cámara y pantalla**: **publicar** está hecho para la cámara
   (`voice_set_camera`, 720p, RGB→I420 a mano porque los ayudantes del SDK dan
   un rodeo por NV12). Pistas independientes de la voz: apagar la cámara en
   mitad de una frase no corta lo que estás diciendo.

   **Compartir pantalla resultó estar casi resuelto**: el `libwebrtc` que ya
   enlazamos trae un `DesktopCapturer` multiplataforma —WGC en Windows,
   ScreenCaptureKit en macOS, PipeWire en Linux— y no hacen falta ni `scap` ni
   bindings propios. Medido en `docs/voz-video.md` §1.

   **Ver lo que publican los demás es el problema abierto**, y no es de layout.
   Con el motor en Rust, las tramas de vídeo llegan al proceso nativo y la
   interfaz vive en un webview: hay que cruzar esa frontera treinta veces por
   segundo. El audio no tuvo este problema porque sale por los altavoces sin
   pasar por la ventana. Las salidas posibles —un esquema propio que sirva las
   tramas como un stream, o memoria compartida y un canvas— son una decisión
   arquitectónica que conviene tomar despierto, no de pasada. El análisis con lo
   que se puede medir de este stack, las cuatro salidas posibles y lo que hizo
   otro equipo con exactamente el mismo problema está en
   [`voz-video.md`](voz-video.md).

18. ~~**La barra de llamada como es debido**~~: hecha. El diseño llegó
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
