# Grabar las llamadas: el acta del terreno

Lo que se ha medido, con fecha y números. Igual que `voz.md` y
`transcripcion.md`: aquí no van ideas, van hechos comprobados y lo que
costaron.

## Por qué Egress y no el bot de `transcriber/`

El spike de transcripción eligió **bot participante** sobre Egress, y con razón
para lo suyo: recibir audio por pista no justificaba `redis:` en LiveKit, una
imagen de 2 GB con Chrome dentro ni un participante oculto.

Para vídeo el bot no sirve, y es un hecho del SDK, no una opinión: entrega los
fotogramas **ya decodificados** (`VideoFrame{data, get_plane, width, height}`;
no hay acceso al RTP). Guardarlos crudos son 41 MB/s por pista a 720p30 —diez
gigas por minuto con cuatro— y re-codificarlos en vivo cuesta más que Egress,
que hace lo mismo en C optimizado.

Egress trabaja un nivel más abajo y por eso puede escribir el flujo **sin
tocarlo**. El bot no se retira: sigue siendo la pieza correcta para la
transcripción, que queda aplazada.

> El diseño inicial era grabar la videollamada compuesta (Room Composite). Se
> cambió a grabar por pistas al decidirse que las cámaras no se capturan; el
> porqué y el coste comparado están más abajo, en «El cambio de rumbo».

## Lo aplicado el 16-sep-2026

### Versiones, y por qué estaban a punto de desparejarse

| | Antes | Ahora |
|---|---|---|
| SFU | `livekit-server:latest` | `v1.13.5@sha256:3497163e…` |
| Grabador | — | `egress:v1.14.1@sha256:bf2b648b…` |
| Bus | — | `valkey:8-alpine@sha256:d2e18f34…` |

Egress y el servidor se hablan por psrpc con los tipos de `livekit/protocol`, así
que sus versiones tienen que casar. Egress v1.14.1 pide `protocol v1.50.1`;
el servidor v1.13.5 va en la misma serie `v1.50.x`. El siguiente, **v1.13.7,
salta a `v1.51` y desparejaría**.

Y había una bomba con fecha: `latest` ya apuntaba a un digest distinto
(`6fd3b708…`) del que estaba sirviendo (`3497163e…`). Con etiqueta `latest` el
`imagePullPolicy` por defecto es `Always`, así que **el próximo reinicio del pod
habría subido el SFU solo**, desparejándolo del grabador. El pin congela lo que
ya corría y está verificado: tras aplicarlo, el binario es el mismo.

### El bus: dedicado, no el Valkey compartido

Egress obliga a `redis:` en el SFU. Se despliega un Valkey **propio en
`default`**, mínimo y sin persistencia (`--save "" --appendonly no`,
`maxmemory 64mb`), en vez de usar el de `data`:

- La voz no debe caer con el bus de eventos SSE de cac.
- Ni depender de una contraseña copiada a mano entre namespaces (el mismo
  desajuste que ya arrastra `cac-valkey`).
- No hay nada que corromper: si se reinicia, los Egress en vuelo se dan por
  fallidos y el reloj del backend lo verá.

**Lo que esto cuesta, dicho en voz alta**: con `redis:` el SFU entra en modo
distribuido. Si el bus cae, sigue sirviendo las salas que ya tiene **pero no
crea nuevas**. Quitar esas dos líneas del ConfigMap apaga la grabación y nada
más.

### La lección de la NetworkPolicy

La primera versión usaba una `NetworkPolicy` estándar que permitía
`ipBlock: 10.0.0.0/8`, pensando en el SFU. **No funciona**, y se probó: con esa
policy puesta, un pod cualquiera no alcanzaba el bus — y el SFU tampoco lo
habría alcanzado, así que la voz se habría roto al arrancar.

Dos razones, ambas de la especificación:

1. `ipBlock` es para tráfico **de fuera del clúster**. El tráfico entre pods se
   describe con selectores, y Cilium lo cumple al pie de la letra.
2. El SFU corre con `hostNetwork`, así que sus paquetes salen con la IP del nodo
   y **ningún selector de pod los describe**.

La forma correcta con Cilium es `fromEntities: host`. Verificado en las dos
direcciones antes de tocar el SFU:

```
un pod cualquiera → bloqueado
desde el host     → alcanzable
```

### Las credenciales de S3

Usuario IAM propio (`guz-reports-media-recordings`), acotado a **escribir bajo
`recordings/*` y nada más**: no lee, no borra, no ve el resto del bucket —donde
viven los adjuntos de cac—. Está en
`infra/terraform/reports-media/iam_recordings.tf` y la llave en 1Password
(«Dwit Accounts»).

Se crea aparte del usuario de image-service a propósito. Ése tiene
`Put/Get/Delete/List` sobre todo el bucket, y el pod al que habría que dárselo
es el que **corre un Chrome** que carga una página y renderiza nombres de
participantes: la pieza más nueva y la más expuesta a entrada rara. Comprometido
el grabador, lo peor que puede hacer es dejar ficheros en su propio rincón.

**Las credenciales no llegan a ningún cliente.** Egress es un pod del clúster,
no una app. Para *ver* una grabación, el cliente va al proxy de cac con su JWT y
cac hace el `GetObject` — igual que con los adjuntos de hoy. Se descartaron las
**URL prefirmadas** a propósito: un enlace prefirmado *es* una credencial para
ese objeto, se reenvía, queda en el historial y sigue funcionando aunque se
quite a la persona del espacio.

> **Incidente, 16-sep-2026.** La primera llave se filtró en la salida de error de
> un comando mal escrito (un heredoc y una tubería peleándose por la entrada
> estándar; bash acabó ejecutando las credenciales como órdenes). Se rotó de
> inmediato, se comprobó en AWS que sólo queda la nueva, y **la filtrada nunca
> llegó a usarse** — el comando falló antes de crear el secreto. El método
> cambió: las credenciales viajan sólo por entrada estándar a un fichero con
> `umask 077`, el guion va por separado, y lo que las manipula es Python, que no
> reinterpreta nada como comando al fallar.

### Que la voz no se rompió

Tras aplicar el pin y `redis:`, el spike de la fase 0 contra una sala nueva:

| | Antes (12-sep) | Tras redis (16-sep) |
|---|---|---|
| Conectar | 0,73 s | **0,32 s** |
| Primera muestra | 1,18 s | **1,01 s** |
| Audio en 120 s | 119,52 s | **119,31 s** |

Mismo 99% de continuidad. El cambio no costó nada.

Y un aviso del arranque que **no** es un problema, para que nadie lo persiga:
`could not validate external IP … from 10.0.0.40`. LiveKit sí encuentra la IP
pública por STUN desde la dirección del host; el aviso es de validarla desde la
privada secundaria, y se cancela porque ya tiene la respuesta.

### La cadena entera, probada de extremo a extremo

Antes de escribir una línea del backend se grabó una sala de verdad a mano, para
que una errata en la política de IAM no apareciera después de quinientas líneas
de Go. Dos bots en `voice:humo-egress`, `StartRoomCompositeEgress` por Twirp con
un token `RoomRecord`, 70 segundos, y parar:

```
EGRESS_COMPLETE
recordings/humo/prueba-egress.mp4   1,23 MB   70,4 s
```

`RoomRecord` es la concesión que LiveKit exige para `Egress.*`. Sin ella
contesta 401, igual que pasó en su día con `ListParticipants` — conviene
recordarlo al escribir el cliente del backend.

Y la frontera de la llave acotada, comprobada en las cuatro direcciones:

| La llave del grabador… | |
|---|---|
| lista su propio prefijo | ✅ puede |
| lista los adjuntos de cac (`org/`) | 🚫 `AccessDenied` |
| lee el fichero que ella misma escribió | 🚫 `AccessDenied` |
| borra el fichero que ella misma escribió | 🚫 `AccessDenied` |

Estrictamente de escritura y estrictamente en su rincón. Leer y borrar son cosa
de cac, con las llaves que ya tenía.

El grabador arrancó diciendo `cpu available: 8, max cost: 4`; con
`room_composite_cpu_cost: 3` eso significa que **acepta una grabación y rechaza
la segunda**, que es lo que este host aguanta.

## El cambio de rumbo: no se compone, se graba por pistas

Todo lo de arriba sigue en pie y **nada de la infra desplegada se tira**. Lo que
cambia es qué se le pide al grabador, y lo decidió una frase de jose al preguntar
qué se vuelve a mirar de una reunión grabada: *«el valor está en ver la pantalla y lo que
alguien está explicando; me la suda verle la jeta a la gente»*.

En cuanto las cámaras salen de la ecuación, el problema deja de ser «componer una
videollamada» y pasa a ser «guardar voz y pantalla». Y eso tiene una herramienta
mucho más barata.

| | Room Composite | **Track Egress + mux** |
|---|---|---|
| Durante la llamada | ~3 núcleos componiendo caras que nadie mira | **~0,1 por pista**, escribe el flujo tal como llega |
| Qué se guarda | todo, ya compuesto | micrófonos + pantalla. **Cámaras no** |
| Calidad | por bitrate, y recomprimir después | **CRF 18 directo** al montar |
| Al colgar | nada | mezclar audio y pegar la pantalla: minutos |
| Transcripción futura | habría que añadirla | **sale gratis**: una pista de audio por persona |

Lo que se gana no es sólo CPU: **el trabajo pesado sale de la llamada**. Y
desaparece el bloqueo que tenía esto parado — ya no hace falta juntar a tres
personas con cámaras para medir si el host aguanta componer, porque no hay nada
que componer.

Se descartó también el **bot participante** para vídeo, y por un hecho
verificado: el SDK entrega los fotogramas **ya decodificados**
(`VideoFrame{data, get_plane, width, height}`; no hay acceso a RTP ni al flujo
codificado). Un bot tendría que re-codificar en vivo — más caro que Egress y en
Python. Track Egress trabaja un nivel más abajo y por eso puede escribir sin
tocar nada.

### Lo que esto obliga a tener en cuenta

**La app publica VP8**, y nadie lo eligió: es el valor por defecto del crate
(`livekit` 0.8.3, `options.rs:158`; los tres `publish_track` de `voice.rs` usan
`..Default::default()`). La pantalla sale en `.ivf`, así que el mux **tiene que
transcodificar** a H.264. Sale barato porque una pantalla compartida es casi
estática, pero es el camino principal, no una excepción. Publicar H.264 desde la
app dejaría el coste en cero; es optimización posterior y no se toca hasta
probar el encoder en los tres sistemas, porque hoy compartir pantalla funciona.

**El audio lleva DTX**: en silencio no se transmiten paquetes. Un mux que alinee
contando muestras en vez de por marca de tiempo desincroniza las voces. De ahí
que la prueba de abajo incluya callarse a mitad.

**Simulcast activo** en la pantalla (capa completa + una de 3 fps). Egress se
suscribe como un cliente más y coge la mejor; no hay que elegir capa.

### Lo primero que salió al grabar por pistas (17-sep-2026)

Antes siquiera de la llamada con pantalla, una prueba con los dos bots dejó tres
cosas que cambian el backend:

**El JSON de Twirp del SFU viene en `snake_case`** (`egress_id`, `started_at`,
`file_results`), no en `camelCase`. Un cliente escrito a mano con
`encoding/json` y campos `camelCase` lee `nil` en silencio — que es exactamente
lo que me pasó y me hizo creer por un momento que LiveKit no daba marcas de
tiempo. Confirma la decisión de usar el **cliente Twirp generado** de
`livekit/protocol`, no uno a mano.

**La extensión del fichero no se adivina.** `ListParticipants` devolvió la pista
de audio **sin `mimeType`**, así que la clave pedida fue `…-TR_xxx` a secas — y
Egress escribió `…-TR_xxx.ogg`, poniéndole la que correspondía al códec real.
Consecuencia para el backend: **`ObjectKey` se guarda desde
`file_results[].filename`, nunca desde la clave que se pidió.**

**El ancla de alineación existe y es precisa.** `FileInfo` trae `started_at` y
`ended_at` en **nanosegundos Unix**, y `ended_at − started_at == duration` al
nanosegundo:

```
started_at 1789672122339974097
ended_at   1789672147099974098
duration      24760000001  (24,76 s)
```

Eso es lo que el mux usa para desplazar cada pista (`adelay`), y por eso el
diseño se sostiene.

### La toma de tres minutos: se monta, y sale barato (17-sep-2026)

Tres pistas grabadas a la vez —micro de una persona, micro del bot, pantalla
compartida—, las tres `EGRESS_COMPLETE`:

| Pista | Tamaño | Duración |
|---|---|---|
| micro (persona) | 2,85 MB | 180,03 s |
| micro (bot) | 2,92 MB | 179,7 s |
| pantalla | 10,3 MB | 179,7 s — **`.webm`, VP8 960×540** |

**El DTX no rompe la línea de tiempo.** Era el riesgo que más pintaba: en
silencio Opus no manda paquetes, y la duda era si el `.ogg` se encogía. No se
encoge. El perfil del micro enseña un valle de 17 dB en los quince segundos que
la persona estuvo callada, y el fichero sigue midiendo 180,03 s contra 180,3 s
de pared: **el hueco se conserva donde estaba**. `aresample=async=1:first_pts=0`
sigue en la receta como cinturón, no como tirante.

La receta que montó los tres en un mp4, tal cual se corrió:

```
ffmpeg -i mic.ogg -i bot.ogg -i screen.webm -filter_complex "\
[0:a]aresample=async=1:first_pts=0[a0];\
[1:a]aresample=async=1:first_pts=0,adelay=396:all=1,volume=0.12[a1];\
[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout];\
[2:v]setpts=PTS-STARTPTS+0.452/TB[vout]" \
-map "[vout]" -map "[aout]" \
-c:v libx264 -preset veryfast -tune stillimage -crf 18 -r 10 -g 50 \
-pix_fmt yuv420p -c:a aac -b:a 96k -ac 1 -movflags +faststart -y final.mp4
```

Los `396` y `452` milisegundos salen de `started_at`: son lo que cada pista
arrancó después de la primera.

**Costó 4,9 s montar 3 minutos** —unas 36 veces más rápido que el tiempo real—
y salieron 6,67 MB para 180,156 s. Eso es **~130 MB por hora** de reunión,
contra los ~3,6 GB/hora que habría dado componer en vivo. El texto de la
pantalla se lee: de un fotograma suelto saqué `ascAppId: 6768794891` sin forzar
la vista.

### El ancla: medida con una claqueta, no con una persona

La puerta decía «el “tres” coincide con el cronómetro ≤ 300 ms». Con una persona
delante **esa medida no se puede hacer**: el tiempo de reacción de quien dice
«tres» al ver el reloj es del mismo orden que lo que se busca, así que se acaba
midiendo a la persona. En la toma real se intentó igual y salió justo eso —
según cómo se emparejaran los teclazos con los cambios de pantalla, el desfase
daba ~0 ms o ~250 ms, que es exactamente la diferencia entre las dos anclas. Con
ese material no se decide nada.

Lo que sí se pudo medir de esa toma, porque la persona compartió `time.is`, es
**el ancla del vídeo contra el reloj del mundo**: el dígito de los segundos
cambia veinte veces, y `started_at + pts` clava el segundo redondo con ~50 ms de
error y 47 ms de dispersión — un intervalo entre fotogramas, o sea, todo lo que
se puede pedir a 20 fps.

Para el audio hizo falta cambiar la fuente. `tools/clapper.py` entra a la sala
como un participante más y publica **micro y pantalla movidos por el mismo
reloj**: cada 6 s, a la vez, un pitido de 60 ms y un destello blanco. En el
origen la diferencia es cero por construcción. Y `egress_tracks.py --stagger`
arranca los dos egress **a propósito con segundos de diferencia**, que es lo que
convierte la claqueta en una prueba y no en una anécdota:

| Toma | `started_at` micro − pantalla | Desfase medido tras alinear |
|---|---|---|
| `clap2` | +60 ms | **+75 ms** (dispersión 35 ms) |
| `clap3` | **−5 777 ms** | **+64 ms** (dispersión 60 ms) |

**Los egress arrancaron con 5,8 segundos de diferencia y los golpes siguieron
coincidiendo dentro de 73 ms.** Si `started_at` no fuera un ancla de verdad, el
error de `clap3` habría sido de casi seis segundos. La puerta de 300 ms pasa con
holgura, y pasa por la razón correcta.

Y el resto (~74 ms) **no es del grabador**: contra el horario que la propia
claqueta imprime, el vídeo llega con 0–5 ms de error y el audio con +74 ms
constantes en las tres tomas. Eso es la cola del `AudioSource` del emisor —
retardo del cliente, no de la grabación. El grabador, medido contra su propia
fuente, no mueve nada.

La lectura para el mux: **se aplica `adelay`/`setpts` con la diferencia de
`started_at`, sin corrección**. Y lo que hay que vigilar en producción es que el
ancla siga siendo `FileInfo.started_at` del `file_results`, no el reloj del
backend al lanzar el egress — ésos sí se separan segundos.

Dos cosas más que salieron de paso, útiles para la fase 3:

- **El SDK publica la pantalla a 5 fps** si no se le pone `video_encoding`
  explícito: el preajuste de pantalla compartida asume que lo que se comparte
  está casi quieto. Se ve en la primera toma de claqueta, donde el destello de
  60 ms desapareció entero. No afecta al grabador —Egress escribe lo que llega—
  pero sí a lo que la app publica.
- **La resolución sale de quien comparte**: 1920×1080 en la toma de la persona,
  960×540 en otra. El lienzo del mux se calcula por toma, como estaba previsto.

## Un egress muerto no se nota, y eso obligó a rediseñar el cierre (18-sep-2026)

La última puerta de la fase 1 era «matar el pod de Egress a mitad y ver las
pistas en `failed` en ≤ 30 s». Se hizo, y falló: las pistas se quedaron en
`active` **157 segundos** sin que nada se enterara. Una grabación así no cierra
nunca, no llega al mux, y no enseña ningún error.

### Las cuatro señales, medidas una a una

Buscando algo que distinguiera un egress vivo de uno muerto se probaron las
cuatro que hay. **Tres no valen**, y cada una se creyó buena un rato:

| Señal | Qué hace de verdad |
|---|---|
| `EgressInfo.status` | Se queda en **`EGRESS_ACTIVE` para siempre**, con `ended_at: 0`. Sigue así horas después |
| `EgressInfo.updated_at` | **No late.** Con el egress sano y grabando se quedó congelado y envejeció linealmente hasta 79 s. LiveKit sólo lo toca al cambiar de estado |
| El participante del egress | **No se va.** Cada egress entra a la sala con su id por identidad (`EG_xxx`, `kind: EGRESS`), y al morir el pod **sigue sentado ahí**: presente los 157 s que duró la prueba |
| `StopEgress` | **Contesta.** 408 `deadline_exceeded` en 3,4 s cuando nadie posee ese egress |

La tercera costó dos intentos: se escribió el arreglo entero sobre la presencia
—parecía la señal natural, y ya se pedía la lista en cada tick— y fue la propia
prueba contra el SFU la que lo desmintió, imprimiendo tick a tick quién estaba
en la sala. El doble habría dicho que sí.

### Preguntar es también parar

`StopEgress` sirve, pero no como latido: preguntarlo **es** pararlo. Así que
sólo se pregunta al cerrar, y de ahí sale el reparto honesto de lo que este
diseño puede y no puede:

- **Mientras se graba, un pod que se muere no se detecta.** Lo escrito antes
  está en S3; lo de después se pierde. Con LiveKit 1.13.5 no hay forma de
  saberlo sin romper la grabación de los que están vivos. Anotado y aceptado.
- **Al parar, se detecta en ~25 s** y la grabación cierra —`partial` si algo se
  salvó, `failed` si no— en vez de colgarse en `finalizing` para siempre.

### Y no vale contar «cualquier error»

Volver a pedir que pare tiene **tres** respuestas, y sólo una significa muerte:

```
cerrando (ENDING)    → 200 OK          · pedirlo dos veces no molesta
ya terminado         → 412 failed_precondition «cannot be stopped»
nadie al otro lado   → 408 deadline_exceeded, en 3,4 s
```

El 412 es buena noticia: LiveKit sabe quién es y el fichero está escrito.
Contarlo como muerte convertiría en `failed` la grabación que salió bien — y
pasa de verdad, porque `ListEgress` y `StopEgress` son dos preguntas distintas
y la lista puede ir un paso por detrás. Se mira el **código** de Twirp, no el
texto, que lleva versión e idioma del servidor.

Medido esto, el periodo de gracia que se había puesto «por si acaso» sobraba, y
salió: la detección bajó de 39 s a 25 s.
→ Guardianes: `service.TestADeadEgressWorkerDoesNotHangTheRecording`,
`TestAnAlreadyFinishedEgressIsNotMistakenForADeadOne`,
`TestAStaleListingDoesNotKillAFinishedTrack`,
`TestOneTransientTimeoutDoesNotKillATrack`,
`TestTheProbeNeverRunsWhileStillRecording`.

### Una nota sobre cómo se mata un pod

`kubectl delete pod` **no** reproduce el fallo: es una baja ordenada, Egress
recibe SIGTERM y termina sus ficheros bien. La primera vez que pasó la prueba,
pasó por eso y no por el arreglo. Hace falta `--force --grace-period=0`.

## Lo que falta medir — lo que queda de la puerta

Lo de la alineación ya está cerrado arriba. Queda lo que sólo se puede medir con
la máquina cargada:

| Medida | Puerta |
|---|---|
| Coste del mux | 10 min de 1080p con `nice` ≤ 2 min, con el host ≥ 20% ocioso |
| Coste de Egress | 3 pistas < 0,5 núcleo (si sobra, bajar `track_cpu_cost` para que 6 personas no topen con el techo) |
| Redis caído a mitad | ¿sigue la voz? ¿se crean salas nuevas? anotar |
| **Egress muerto a mitad** | **hecho**: ver arriba. Se detecta al parar, en ~25 s |

Ninguna de las tres puede tumbar el diseño: la primera mueve un límite del
`Deployment` del mux, la segunda un número del `values` de Egress, la tercera ya
se sabe a medias (la voz aguantó cuando se le puso el bus). La que podía
tumbarlo era la alineación, y no lo hace.
