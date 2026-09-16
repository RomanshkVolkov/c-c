# Grabar las llamadas: el acta del terreno

Lo que se ha medido, con fecha y números. Igual que `voz.md` y
`transcripcion.md`: aquí no van ideas, van hechos comprobados y lo que
costaron.

## Por qué Egress y no el bot de `transcriber/`

El spike de transcripción eligió **bot participante** sobre Egress, y con razón
para lo suyo: recibir audio por pista no justificaba `redis:` en LiveKit, una
imagen de 2 GB con Chrome dentro ni un participante oculto.

Grabar la videollamada compuesta es otro problema. Una llamada de cac lleva
hasta **tres pistas por persona** —micrófono siempre, cámara 720p, pantalla— y
el bot recibe los fotogramas **ya decodificados** (I420, ~40 MB/s por cámara).
Componerlos y re-codificarlos en Python sobre este host es reescribir Egress a
mano y peor.

Lo que era desproporcionado para transcribir es lo proporcionado para grabar. El
bot no se retira: sigue siendo la pieza correcta para la transcripción, que
queda aplazada.

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

## Lo que falta medir — la puerta de la fase 0

**La pregunta abierta: ¿aguanta este host componer en tiempo real?** Chrome y
x264 compiten con el SFU en 8 vCPU donde ya viven cac ×2, Postgres, Valkey y
~2 cores fijos de plano de control.

Se mide con una llamada real de **3 personas con cámaras y una pantalla
compartida**, 10 minutos a 1080p30/8 Mbps y 10 a 720p30/5 Mbps:

| Medida | Cómo | Puerta |
|---|---|---|
| CPU del pod Egress | `cpu.stat` del cgroup | ≤ 3,5 cores a 1080p; ≤ 2,5 a 720p |
| Ocioso del host | `vmstat 5` | ≥ 20% sostenido |
| Latencia de los clientes | el `ms` que pinta `VoiceStage`, antes y durante | mediana +≤ 20 ms; p95 +≤ 50 ms |
| Voz | los 3 dicen si oyen cortes | cero cortes |
| Legibilidad | pantalla con texto pequeño, a ojo | legible |
| Sala vacía | los 3 salen; cronómetro hasta `COMPLETE` | anotar |

**Si no pasa ni a 720p**, el plan cambia a **Track Egress** (muxea sin
decodificar, casi cero CPU) **+ composición offline con ffmpeg en rejilla
estática**: se pierde el diseño dinámico, se gana no tocar la latencia de nadie.
El dominio `Recording` del backend no cambia en ninguno de los dos casos.
