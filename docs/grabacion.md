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

## Lo que falta medir — la puerta de la fase 0

La pregunta ya no es si el host aguanta. Es **si el vídeo montado queda bien
alineado**, que es lo único que puede salir mal en este diseño.

Se graba por pistas una llamada corta: `spike_speaker` como segundo
participante, y una persona real desde la app que **comparte pantalla con un
cronómetro visible**, **cuenta en voz alta «uno… dos… tres»** al arrancar la
pantalla, y **se calla 20 segundos a mitad**. Tres minutos bastan.

| Medida | Puerta |
|---|---|
| Objetos en S3 | `.ogg`×2 + `.ivf`, todos `EGRESS_COMPLETE`; anotar la unidad de `FileInfo.StartedAt` |
| Duración del `.ogg` con el mute | ≈ tiempo de pared **±1 s**. Si no, `aresample=async=1` lo corrige: anotar cuál hizo falta |
| Sincronía voz/imagen | el «tres» coincide con el cronómetro **≤ 300 ms** |
| Legibilidad | texto pequeño legible a 10 fps y CRF 18; si no, subir fps |
| Coste del mux | 10 min de 1080p con `nice` ≤ 2 min, con el host ≥ 20% ocioso |
| Coste de Egress | 3 pistas < 0,5 núcleo (si sobra, bajar `track_cpu_cost` para que 6 personas no topen con el techo) |
| Redis caído a mitad | ¿sigue la voz? ¿se crean salas nuevas? anotar |

**Si la alineación no cuadra ni con `aresample`**, se re-planifica el mux antes
de escribir una línea de backend. El dominio `Recording` no cambia en ningún
caso.
