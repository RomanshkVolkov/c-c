# Notificaciones: qué avisa, a quién, y qué sigue capado

Este documento es el mapa completo de los eventos de cac y de cuáles dejan algo
que se pueda leer más tarde. Se escribió después de perder un comentario de un
cliente: escribió con la app cerrada y no quedó constancia en ninguna parte.

Última revisión: **2026-08-19**.

## 1 · Tres cosas distintas que se confunden

Lo primero, porque casi todo el lío viene de tratarlas como una:

| Capa | Dónde vive | Sobrevive a cerrar la app |
|---|---|---|
| **El stream** | `events.Hub` → SSE → `use-report-events.ts` | **No.** Si nadie escucha, el evento se pierde |
| **El aviso del SO** | `notify()` en `use-report-events.ts:129`, registrado en `notifications.store.ts` | **No.** Es un registro local de esta sesión |
| **La bandeja** | tabla `notifications` → `/api/v1/notifications/` → la campana | **Sí.** Es la única con «no leído» |

Sólo la tercera es una notificación en el sentido que le da un humano. Las otras
dos son ecos del momento. Un evento que sólo llega por el stream es un evento
que se pierde entero si el destinatario tenía la app cerrada — que es
exactamente lo que pasó con `portento-84`.

## 2 · El mapa

Todos los eventos que emite el backend, y qué deja cada uno.

| Evento | Se emite en | ¿Deja fila? | Clase | A quién |
|---|---|---|---|---|
| `report:new` — un cliente levanta algo | `report.go:243` | **Sí** | `report:new` | responsable del proyecto; sin él, toda la org |
| `report:new` — el equipo publica en el tablero de un cliente | `task.go:708` | No, **a propósito** | — | lo causa un compañero; ver §5 |
| `report:comment` — el reporter en su propio hilo | `report.go:381` | **Sí** | `task:comment` | toda la organización |
| `report:comment` — camino compartido (equipo o app del tenant) | `report.go:710` | **Sí** | `task:comment` | de fuera → toda la org; `team` → los implicados |
| `report:comment` — una **edición** de un comentario | `report.go:856` | No, a propósito | — | corregir una errata no es noticia |
| `report:comment` — desde el lado de tareas | `task.go:822` | **Sí**, vía `task.go:817` | `task:comment` | los implicados |
| `task:comment` | `task.go:814` | **Sí** | `task:comment` | los implicados, nunca el autor |
| `chat:message` | `chat.go:67` | **Sí** | `chat:message` · `chat:mention` | toda la org menos quien se salió · quien es nombrado |
| `dm:message` | `dm.go:51` | **Sí** | `dm:message` | el destinatario |
| `report:status` | `report.go:609`, `task.go:550` | **Sí** | `task:status` | los implicados |
| `task:new` con responsables | `task.go:419` | **Sí** | `task:assigned` | a quien se le asigna, nunca a quien asigna |
| `task:update` que cambia responsables | `task.go:498` | **Sí** | `task:assigned` | **sólo a los nuevos** — ver abajo |
| `task:move` que cambia de columna | `task.go:554` | **Sí** | `task:status` | los implicados |
| `task:move` dentro de la misma columna | `task.go:554` | No, y está bien | — | reordenar no es una noticia |
| `report:attachment` | `report.go:908` | **No** — sigue capado | — | — |
| `task:delete` | `task.go:567` | No | — | |
| `voice.ring` — te llaman a una sala | `voice_ring.go:47` | **No, a propósito** | — | **una sola persona**, vía `Event.UserID` |
| `voice.ring.cancel` — colgaron, o rechazaste | `voice_ring.go:79` | No | — | la otra persona de esa llamada |
| `meeting:reminder` — empieza una reunión periódica | `meeting.go` (`anunciar`) | **Sí** | `MeetingsQuiet` | **una sola persona**, vía `Event.UserID`, a cada convocado |

**El timbre no deja fila en la campana**, y eso es una decisión y no un
descuido. Una llamada caduca en veinte segundos: una entrada en el historial
que dice «Bea te llamó» y ya no se puede contestar es un recordatorio de algo
que no se puede hacer. Lo que sí hace es una notificación **del sistema**
—cuando la ventana no está delante— y la tarjeta a pantalla completa, que es la
única cosa de la app que se pone encima de todo lo demás. Si alguna vez hace
falta el «te llamaron y no lo cogiste», eso es un mensaje en el canal, que sí
espera.

«Los implicados» es `ReportRepository.Involved(itemID)`: responsables ∪
seguidores ∪ quien ya escribió en el hilo, en una sola consulta. La decisión de
a quién avisar vive entera en `service/avisos.go` y en ningún otro sitio.

**«Sólo a los nuevos»** es `TaskService.reciénAsignados`. Guardar responsables
reemplaza la lista entera, así que sin la diferencia se avisaría otra vez a quien
ya la tenía cada vez que alguien toca cualquier otro campo de la tarjeta.

## 2 bis · Seguir un canal es lo que pasa por defecto

Desde el 21/08/2026: **todo miembro de una organización sigue todos sus canales**
y recibe aviso de cada mensaje. Lo que se guarda es la excepción — `space_mutes`,
quién se salió de cuál — y por eso no hay nada que rellenar al alta de un miembro
ni al alta de un espacio.

`Followers(spaceID)` ya no lee una lista propia: son los miembros de la
organización del espacio menos los silenciados. Un espacio no tiene miembros
suyos —cualquiera de la organización lo alcanza—, así que inventarle una lista
sería una segunda verdad sobre quién está dentro.

Los endpoints conservan ruta y verbo (`POST …/chat/follow` quita el silencio,
`DELETE` lo pone) para que una build vieja siga funcionando. `space_followers`
queda en la base sin que nadie la lea.

**El precio, dicho claro:** cada línea de cada canal llega a todos los colegas
salvo al autor y a los ya nombrados. Con equipos pequeños es lo que se quiere.
Cuando seáis diez, o haya diez canales, esto se convierte en la copia del chat
que el diseño anterior evitaba — y la válvula es el interruptor «Channels you
follow», que apaga la clase entera. Si llega ese día, el arreglo no es volver
atrás sino agrupar: un aviso por canal y por rato, no uno por línea.

**Ese día llegó** (27/08/2026) y está hecho: ver §2 ter.

## 2 ter · Plegar: una fila por conversación

Diez mensajes de un canal son **una fila** con el nombre, el último mensaje y un
contador, que se despliega y se vuelve a plegar. Pulsar la cabecera marca el
grupo entero leído y lleva a la conversación — abrir algo **es** haberlo leído;
dejar el contador puesto obligaría a volver a la campana a limpiarlo a mano.

### La clave, y por qué no se escribe a mano

Cada fila lleva `GroupKey` (`space:<id>`, `dm:<id>`, `item:<id>`,
`meeting:<id>`) y `GroupLabel` (cómo se llama para un humano). Las claves salen
**siempre** de las constructoras de `domain/notification_group.go`.

Si un sitio escribiera `"space:"+id` y otro `"space-"+id`, los dos serían
válidos, ninguno daría error y sus avisos **nunca se agruparían juntos**. Un
fallo sin excepción, sin log y sin más síntoma que ver dos filas del mismo canal
en el panel. La gramática tiene que ser imposible de falsificar.

**Dos campos y no uno** porque el rótulo no se deriva con una sola regla: en un
canal vive en el `Title` de la fila, y en una tarea vive en el `Body` mientras el
`Title` dice qué pasó («Bea replied»). Los papeles se invierten según la familia.

### La regla que parece un detalle y no lo es

> **La familia sale del `Kind`. El id sale del enlace. Nunca al revés.**

`meeting:reminder` usa **el mismo enlace** que un mensaje de canal
(`/chat?space=X`). Deducir la familia del enlace metería «empieza la daily»
dentro del grupo de mensajes de esa sala. Hay una prueba dedicada a esto en los
dos lados —`domain/notification_group_test.go` y
`app/src/lib/notification-groups.test.ts`— porque es lo que a alguien le va a
apetecer «simplificar».

Y por eso los recordatorios **antiguos** no se agrupan: su fila no contiene la
identidad de la reunión por ningún sitio, así que no hay nada que deducir. Los
nuevos sí, porque `meeting.go` pasa `MeetingGroup(m.ID)`.

### El histórico, sin migrar nada

`Feed` rellena la clave **al leer** las filas que no la tengan, con
`DeriveGroup(kind, link)`. Sin backfill, sin SQL de un motor concreto, y la
columna guardada sigue siendo la verdad: el día que un enlace cambie de forma,
la deducción se rompe y lo almacenado no.

Esa deducción vive **en el servidor**. En el cliente habría dos algoritmos
obligados a estar de acuerdo para siempre, y el día que discreparan las filas
viejas y las nuevas del mismo canal formarían dos grupos — un fallo que se ve
raro y no se explica. La app conserva una deducción propia sólo como red para
builds más nuevas que el backend; el servidor manda siempre (`groupKey` gana).

### Decisiones de la pantalla, con su porqué

- **Se parte en {sin leer, leídas} y *después* se agrupa.** Un grupo con las dos
  cosas no se puede colocar: arriba subiría lo ya leído por encima del rótulo
  «Read», abajo escondería avisos nuevos debajo de él.
- **Orden por el miembro más nuevo**, nunca por tamaño: un canal charlatán y
  viejo se plantaría arriba para siempre.
- **Un grupo de uno se pinta como antes** — sin galón ni contador. Un «(1)» con
  un triángulo que despliega la fila que ya estás mirando es puro adorno.
- **En un directo se cuenta, no se enseña el texto**: «2 new messages». El
  servidor manda el cuerpo vacío a propósito (ver `dm.go`) y la cabecera no
  puede destaparlo. Hay una prueba que lo vigila.
- **El estado de apertura va por clave de grupo.** `releerBandeja()` reemplaza el
  array entero en cada evento; indexado por índice o por id de fila, cada mensaje
  que llegara cerraría el grupo que el usuario acaba de abrir.
- **El icono es el de la familia**, salvo que haya una mención dentro: entonces
  la arroba. Es lo único que decide si tienes que abrirlo ya.
- **Sin ventana temporal**: partiría el mismo canal en dos grupos, que se lee
  peor que uno solo.

### Contar de verdad, y marcar de verdad

`Feed` devuelve además `groups: []GroupTally` — un `GROUP BY group_key` sobre
**toda** la bandeja, no sobre la página de 50. Sin eso, «#portento (50)» con
trescientos guardados sería una cifra inventada.

Y por eso `POST /notifications/read` acepta `{group, orgId}` además de `{ids}`:
**las dos cosas van juntas, y separarlas sería peor que no hacer ninguna.** El
cliente sólo tiene los ids que le cupieron en la página, así que con contadores
verdaderos y marcado por ids, pulsar una fila de 47 la dejaría diciendo cero
mientras el badge se queda en 35. Una mentira visible.

Como en `MarkRead`, la clave de grupo se acota al llamante **dentro de la
consulta**: suelta, dejaría marcar la bandeja de otra persona.

Al desplegar, si el servidor cuenta más de los que llegaron, se dice —«Showing 12
of 47»—. Enseñar 47 y desplegar 12 sin avisar parece que faltan avisos.

### Lo que sigue capado

- **Los recuentos sólo cubren las filas con clave guardada.** Las antiguas se
  agrupan al pintarse —la clave se deduce al leer— pero contarlas exigiría
  deducir dentro de SQL, que es la clase de lógica que no se puede probar sin
  base de datos. Su contador sale de la página, y son pocas: las viejas.
- **Expandir enseña sólo lo que cupo en la página.** Lo que se hace con un grupo
  de 47 es abrirlo y darlo por leído, no leer 47 filas en un desplegable.
- **Sin paginación.** Si algún día hace falta, el sitio es `Feed`, y el cursor
  natural es `created_at` con el id como desempate.

## 3 · Las clases y sus interruptores

Una clase de notificación necesita cuatro cosas alineadas o queda a medias:

| Clase | ¿La escribe alguien? | Interruptor (`Allows`) | En el panel (`CLASES`) | Pestaña |
|---|---|---|---|---|
| `chat:mention` | `chat.go:91` | **nunca se silencia** | ✅ `mention` | Talk |
| `dm:message` | `dm.go:62` | `dms` | ✅ `direct` | Talk |
| `chat:message` | `chat.go:111` | `messages` | ✅ `channel` | Talk |
| `task:comment` | `avisos.go:91` | `comments` | ✅ `comment` | Tasks |
| `report:new` | `avisos.go` | `reports` | ✅ `report` | System |
| `task:assigned` | `avisos.go` | `workQuiet` (invertida) | ✅ `assigned` | Tasks |
| `task:status` | `avisos.go` | `workQuiet` (invertida) | ✅ `status` | Tasks |

Las siete están completas. **Hasta el 19/08/2026 dos de ellas no lo estaban**:
`task:comment` y `report:new` tenían su `case` en `Allows`, su interruptor en el
diálogo y su pestaña en el panel, y **ningún servicio escribía una sola fila**.
Eran controles que no gobernaban nada.

Sobre `Mentions`: el campo existe en el modelo y en la API, pero el handler lo
fuerza a `true` (`handler/notification.go:76`) y `Allows` devuelve `true` sin
mirarlo. Es deliberado y está escrito en el dominio: que te nombren no se apaga.
No es un campo muerto, es uno con un solo valor legal.

Sobre `WorkQuiet`: **se guarda al revés que las demás, y a propósito.** Una
columna nueva sobre una tabla con filas nace en el cero de su tipo, así que un
`Work bool` habría llegado en `false` —apagado— para todo el que ya tuviera
preferencias guardadas, que son justo los que más usan esto. Al revés, el cero
significa «no lo he apagado». El diálogo le da la vuelta al pintarlo
(`OPCIONES[].invertida`) para que el interruptor diga lo que hace.

## 3 bis · De dónde vino: la etiqueta del agente

Cada notificación guarda **quién la causó** en `Notification.Via`: vacío la app,
`"mcp"` un agente a través del servidor MCP. El panel lo pinta como un chip
aparte del que ya lleva la clase, porque son dos preguntas distintas — la clase
dice *qué* pasó y esto dice *quién* lo hizo.

Cómo viaja:

1. El servidor MCP pone `X-Cac-Via: mcp` en cada llamada a cac (`app/src-tauri/src/mcp.rs`).
2. `AuthMiddleware` la lee al contexto (`domain.WithVia`), después de validar el token.
3. El servicio la saca con `domain.ViaFrom(ctx)` y se la pasa a `Notify`, que es
   un **parámetro** y no un campo escondido: el compilador no se olvida de los
   parámetros, así que lo próximo que escriba notificaciones tendrá que contestar
   de dónde viene.
4. `NormalizeVia` deja pasar sólo lo conocido. Sin esa lista cerrada, cualquier
   cadena acabaría pintada como etiqueta en el panel de todo el mundo.

**Y no es seguridad.** El servidor MCP escribe con el token de su dueño, así que
una petición suya ya puede hacer todo lo que él puede; la cabecera es una
declaración voluntaria y quien tenga el token puede omitirla o mentir. Su
trabajo es ser honesta con quien lee la campana, no impedir nada. Tratarla como
una barrera sería peor que no tenerla, porque daría una garantía falsa.

Chat y directos pasan `ViaApp` fijo: hoy ninguna herramienta del MCP escribe en
un canal ni un directo. El día que exista una, esos dos servicios necesitan el
contexto de la petición — está anotado en el propio código, en `chat.go` y
`dm.go`, junto a la llamada.

## 4 · Lo que sigue capado

Por orden de lo que más duele:

### 4.1 · Adjuntos que llegan después

`report:attachment` es casi siempre «el cliente sube la captura que le pediste».
Justo lo que estás esperando, y sin aviso.

### 4.2 · El navegador se pierde dos eventos

`use-report-events.ts:407` suscribe once tipos por `addEventListener` y **omite
`chat:message` y `dm:message`**, aunque el `switch` sí los trata. En la app de
escritorio da igual —el stream lo lleva Rust (`sse.rs`) y reenvía cada trama
verbatim—, pero la ruta `EventSource`, que existe para correr la interfaz en un
navegador normal, se los come en silencio.

## 5 · Reglas para no volver a romperlo

**Una clase nueva no es gratis.** La app es un binario de escritorio que se
actualiza a mano, así que hay builds viejas ahí fuera. Una clase que no está en
su `CLASES` cae en `DESCONOCIDA` —pestaña «System», sin etiqueta— y, peor, si no
tiene `case` en `Allows` devuelve `true` y **ningún interruptor la silencia**.
Antes de inventar una clase, comprobar si encaja en las cinco que ya hay.

**Al actor nunca se le avisa.** Que la app te cuente lo que acabas de escribir es
un fallo que este codebase ya quitó tres veces: del chat, de los directos y de
los comentarios. Por eso los eventos llevan `actorId`.

**La preferencia se comprueba en un solo sitio**, dentro de
`NotificationService.Notify` (`service/notification.go:36`). Ningún servicio
decide por su cuenta si alguien quiere algo; si lo hiciera, un interruptor
dejaría de funcionar sin que nadie lo notara.

**Escribir la fila nunca puede tumbar la acción que la causó.** `Notify` se traga
sus errores a propósito: enterarse tarde es una molestia, no poder hablar es un
fallo.

**El enlace es `/tasks?task=<id>`.** `/reports?open=<id>` sigue existiendo sólo
para las filas antiguas (`ReportsRedirect.tsx`); escribir más de ésas sería
alimentar un redirect en vez de usarlo.

**Publicar al bus y anotar en la bandeja son dos trabajos.** Estuvieron bajo la
misma condición en `chat.go`: sin Valkey no se anotaba ni una notificación, así
que una configuración sin bus dejaba de avisar a todo el mundo sin dar ningún
error. Están separados desde entonces (`publicarAlStream` / `anotarAvisos`) y
conviene que sigan así.

## 6 · Ver también

[`canales.md`](./canales.md) — de dónde sale un item y dónde aterriza. Este
documento mapea **qué avisa**; aquel, cómo un reporte de cliente llega a tener
un tablero al que la notificación pueda apuntar. Se escribió cuando la primera
notificación de `report:new` apuntó a un reporte que no estaba en ninguna parte.

## 7 · Dónde tocar

| Qué | Dónde |
|---|---|
| A quién avisar | `backend/internal/core/service/avisos.go` |
| Escribir la fila y comprobar preferencias | `service/notification.go` |
| Clases permitidas y valores por defecto | `domain/notification.go` |
| Enchufar el buzón a un servicio | `WithNotifier` en `task.go`, `report.go`, `chat.go`, `dm.go`; montado en `http/task.go` y `http/report.go` |
| Pintar el panel | `app/src/components/NotificationsPanel.tsx` (`CLASES`) |
| Los interruptores | `app/src/components/NotificationPrefsDialog.tsx` (`OPCIONES`) |
| Refrescar la campana en vivo | `releerBandeja()` en `app/src/hooks/use-report-events.ts` |
| Cómo se agrupa (la gramática de claves) | `backend/internal/core/domain/notification_group.go` |
| Cómo se pliega y se lee un grupo | `app/src/lib/notification-groups.ts` |
