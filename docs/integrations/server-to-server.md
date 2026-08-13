# Integración server-to-server con el módulo de reportes

Cómo una aplicación cliente ("inquilino") usa cac como su gestor de bugs desde su
propio backend: recibe los reportes de sus usuarios, opera su tablero y responde,
todo con la credencial que ya tiene.

Es una de las dos formas de integrarse. La otra es el **widget** (`widget/README.md`),
que se incrusta en el navegador y solo sabe crear reportes. La diferencia que manda
sobre todo lo demás: **aquí la credencial no viaja al navegador**, y por eso puede
leer.

> Contrato estable. Si algo de aquí no coincide con el comportamiento real, es un bug
> del documento o del código — no una excepción que haya que descubrir integrando.

---

## 1. La credencial

Una sola: la **ingest key del proyecto**, en la cabecera `X-Ingest-Key`. La misma
que crea reportes opera el tablero. No hay usuario de servicio, ni contraseña, ni
token colgado de una persona.

```
X-Ingest-Key: pk_...
```

Se muestra **una única vez**, al crear el proyecto; después solo queda rotarla desde
la app de cac (Reports → Projects → Rotate ingest key). De ella se guarda solo un
HMAC, así que nadie —tampoco nosotros— puede recuperarla.

**Solo funciona con proyectos `platform: "app"`.** Un proyecto `web` responde:

```json
403  {"error": "key-not-server-to-server"}
```

No es burocracia: la key de un proyecto `web` va impresa dentro del JavaScript que
descarga el navegador, así que cualquiera que visite la página puede leerla. Que
sirva para *crear* reportes es un costo aceptado, acotado por el límite de tasa. Que
sirviera para *leer* sería publicar el tablero. La puerta está en
`internal/adapters/middleware/report_key.go`.

### Qué alcanza

Acotada a **un** proyecto. Las organizaciones del llamador se dejan vacías a
propósito, para que ninguna comprobación caiga de vuelta en "es miembro de la org" y
le entregue los proyectos vecinos. Las dos únicas puertas de autorización viven en
`internal/adapters/handler/report_admin.go` (`authorize()` y `List`), y las dos
preguntan lo mismo: *¿este reporte es de mi proyecto?*

Fuera de `/api/v1/reports` responde `403 endpoint-not-key-reachable`. Tareas, notas,
usuarios y la administración de proyectos quedan fuera: es la credencial de un
tablero, no una cuenta.

### La regla de Origin no te aplica

Un proyecto `app` está **exento**. No hay navegador que mande la cabecera `Origin`,
y los orígenes que llegaran a estar registrados en un proyecto así quedan inertes.

Para proyectos `web` sí es ley: si la lista no está vacía, es la única entrada, y
eso incluye a quien **no manda** la cabecera (un `curl` replicando la key del
widget) — `origin-missing` y `origin-not-allowed` según el caso.

---

## 2. Mapa de operaciones

Base: `https://cac.guz-studio.dev`

| Operación | Endpoint | Credencial |
|---|---|---|
| Crear reporte | `POST /ingest/v1/reports` | Ingest key |
| Reporte de sistema | ídem con `origin=system` (dedup por título) | Ingest key |
| Telemetría de app nativa | `POST /ingest/v1/events` | Ingest key |
| Listar el tablero | `GET /api/v1/reports` | Ingest key |
| Reportes de una persona | `GET /api/v1/reports?reporterId=` | Ingest key |
| Detalle | `GET /api/v1/reports/{id}` | Ingest key |
| Cambiar estado, prioridad, categoría, área | `PATCH /api/v1/reports/{id}` | Ingest key |
| Responder | `POST /api/v1/reports/{id}/comments` | Ingest key |
| Adjuntar imágenes | `POST /api/v1/reports/{id}/images` | Ingest key |
| Corregir la propia respuesta | `PATCH /api/v1/reports/{id}/comments/{commentId}` | Ingest key |
| Retirar la propia respuesta | `DELETE /api/v1/reports/{id}/comments/{commentId}` | Ingest key |
| Quitar una imagen | `DELETE /api/v1/reports/{id}/images/{imageId}` | Ingest key |
| Transiciones válidas | `GET /api/v1/reports/transitions` | Ingest key |
| Categorías y prioridades | `GET /api/v1/reports/taxonomy` | Ingest key |
| Vista del reporter | `GET /ingest/v1/reports/{id}?token=` | Token del reporte |
| Comentar como reporter | `POST /ingest/v1/reports/{id}/comments?token=` | Token del reporte |
| No leídos en lote | `POST /ingest/v1/reports/unread` | Token del reporte, uno por item |

**No mandes `projectId`.** El servidor lo impone desde la key; uno ajeno no da error,
da lista vacía —para no confirmar que ese proyecto existe— y nunca los tuyos, que
sería devolver datos que no pediste bajo el id de otro.

Consume `transitions` y `taxonomy` del servidor en vez de copiar las listas: es la
diferencia entre una fuente y dos que se separan.

### Crear un reporte

`multipart/form-data`. Campos, todos opcionales salvo `title`:

`title` · `description` · `url` · `userAgent` · `viewport` · `reporterName` ·
`reporterEmail` · `reporterId` · `origin` · `category` · `priority` · `area` ·
`telemetry` · `snapshot` · `context` · `images` (hasta 5, 5 MB cada una,
`png`/`jpeg`/`webp`/`gif`)

### El cuerpo de cada llamada

Todo lo que escribe comentarios es `multipart/form-data`. **También el PATCH** —
es la asimetría que más tiempo cuesta si no se dice:

| Operación | Cuerpo |
|---|---|
| `POST …/comments` | `body`, `images`, `authorName`, `authorId` (§3) |
| `PATCH …/comments/{id}` | `body`, `images`, `removeImageIds` — ver §3 |
| `DELETE …/comments/{id}` | sin cuerpo |
| `DELETE …/images/{id}` | sin cuerpo, y **sólo galería** (§3) |

`POST` y `PATCH` de comentario devuelven **el hilo entero ya actualizado**, así que
no hace falta volver a pedir el detalle.

`category` y `priority` se normalizan: lo desconocido cae en `other` y `medium`, así
que un valor nuevo nunca rompe el alta. `origin=system` activa el dedup por título
contra los reportes abiertos del proyecto, para que un proceso automático que
reintenta no inunde el tablero.

Respuesta:

```json
{ "id": "...", "seq": 12, "folio": "portento-12", "images": 1,
  "token": "...", "deduped": false }
```

`token` es el token de ese reporte (§5). `deduped: true` significa que se devolvió
un reporte existente en vez de crear uno nuevo.

---

## 3. Quién es quién

Un comentario tiene **una de tres** clases de autor, y el servidor la declara en el
campo `author` en vez de dejar que la deduzcas de qué campos vienen nulos:

| `author.kind` | Quién es |
|---|---|
| `user` | una persona con cuenta en cac |
| `reporter` | la persona que abrió **este** reporte |
| `tenant` | una persona de tu app que **no** abrió este reporte |

**La clase sale de quién escribió, no de por dónde entró.** Manda `authorId` en
todos tus comentarios: si coincide con el `reporterId` de ese reporte, cac lo lee
como del reporter; si no, como de tu equipo. Una sola credencial y un solo
endpoint para los dos casos.

Esto importa porque lo contrario te obligaba a elegir. Cuando la clase dependía
del endpoint, un comentario del reporter tenía que entrar por la vía del token —y
esa vía no guarda proyecto, así que **nadie podía editarlo después**—, mientras que
mandarlo por la key lo atribuía a tu proyecto y hacía que tu propio filtro de eco
lo descartara, dejando a tu equipo sin enterarse de que un usuario había
respondido.

```json
"author": { "kind": "tenant", "name": "José",
            "projectId": "…", "projectName": "portento", "externalId": "42" }
```

Ausente en los comentarios de sistema: el `kind` del propio comentario ya lo dice.

`name` viene relleno en los tres casos, así que para pintar la firma basta
`author.name`: el que mandaste en `authorName`, o el que dio la persona al abrir el
reporte si vino por el widget.
Los campos planos `authorName` / `authorLabel` / `authorUserId` siguen viajando por
compatibilidad, pero no los uses en código nuevo: no distinguen las tres clases.

### Firma tus respuestas con la persona, no con la app

`POST /api/v1/reports/{id}/comments` acepta dos campos opcionales:

| Campo | Qué es |
|---|---|
| `authorName` | Cómo se llama quien responde. Es lo que se muestra |
| `authorId` | El id de esa persona **en tu app**, para que puedas atribuirla luego |

Sin ellos la respuesta se firma con el nombre del proyecto, y todo tu equipo aparece
como una sola voz. **No metas el nombre dentro del cuerpo**: mezcla metadato con
contenido y obliga a cada consumidor —cac, el hilo del reporter, el webhook— a
parsear prosa.

Es el mismo trato que `reporterId`/`reporterName` en el alta, y por la misma razón:
esa persona no tiene cuenta en cac. Lo que se guarda es **quién avala** (tu
proyecto, probado por la key) y **quién dices que fue** (texto libre).

> **Autodeclarado.** cac no puede verificar ese nombre, así que nunca lo muestra
> solo: en el tablero se lee **"José · portento"**. Un inquilino que mandara
> `authorName: "admin"` no puede pasar por el usuario `admin` de cac.

De un usuario de cac estos campos se **ignoran**: su identidad ya está probada por
su token, y dejarle sobrescribirla sería una función de suplantación.

### reporter y assignee no son la misma clase de cosa

| | reporter | assignee |
|---|---|---|
| Qué es | texto libre: el id del usuario **en tu aplicación** | un usuario de cac con membresía en la organización |
| Por qué | quien reporta nunca va a tener cuenta en cac | de él cuelgan "asignado a mí", los filtros y el nombre que pinta el tablero |
| Cómo lo lees | `reporterId`, en la lista, el detalle y **cada evento** del webhook | `assigneeName`, en la lista y el detalle |

Lo que suele malinterpretarse: **para mostrar el asignado no hay que hacer nada**.
`assigneeName` viene en la misma respuesta que los reportes — sin petición extra, sin
mapear usuarios, sin crear cuentas. El triage interno es de cac; tú lo pintas.

Cambiarlo desde fuera es otra cosa: necesitarías los uuid válidos, y la key no puede
listar usuarios. Hoy no hay endpoint para eso porque ninguna integración lo ha
pedido. Si lo necesitas, pídelo — es pequeño.

### Cómo ve tu respuesta cada lado

| Quién escribió | En cac | En tu app | En la vista del reporter |
|---|---|---|---|
| Una persona con cuenta en cac | `admin` | — | `team` |
| Alguien tuyo que no abrió el reporte | **`José · portento`** | `José` | `team`, con `authorName` |
| La persona que abrió el reporte | `Ana` | `Ana` | **`you`** |

El sufijo `· portento` sólo aparece en la consola de cac, y sólo en la fila del
medio: ese nombre lo afirmas tú y no lo verifica nadie, así que sin él uno que
mandara `admin` se leería igual que el usuario `admin` de cac. En un comentario
del reporter no aparece — ahí la identidad ya es la del reporte.

Y el comentario del reporter **sigue siendo tuyo para editar y retirar**, porque
lo escribiste con tu key. Eso es lo que antes era imposible.

El reporter **no** recibe el nombre del proyecto: es usuario de tu app y no tiene por
qué saber que cac existe. Y `author` sigue siendo `"you" | "team" | "system"` — el
nombre va en un campo aparte para no romper a quien haga `switch` sobre ese valor.

Una respuesta del inquilino **cuenta como no leída** para el reporter, igual que la
de una persona.

### Qué puedes tocar y qué no

Puedes corregir y retirar **las respuestas de tu proyecto** — cualquiera de ellas, no
sólo las que mandó una persona concreta: la key es del proyecto, así que si quieres
que sólo el autor real pueda editar, esa comprobación va en tu app, donde sí hay
sesión.

No las de una persona del equipo de cac, no las del reporter, y los comentarios de
sistema son inmutables para todos. Borrar el reporte entero queda fuera: eso es
descartar el reporte de un usuario, no ordenar tu propia conversación.

### Editar es una operación, no tres

`PATCH /api/v1/reports/{id}/comments/{commentId}`, multipart:

| Campo | Qué hace |
|---|---|
| `body` | **Ausente = no se toca.** Presente = reemplaza el texto |
| `images` | Ficheros a añadir, mismos límites que al crear |
| `removeImageIds` | Ids a quitar; repetido, o uno separado por comas |

Las tres cosas viajan juntas y se aplican **o todas o ninguna**. Si nombras una
imagen que no es de ese comentario, la petición se rechaza entera y el texto
tampoco cambia — no queda media edición aplicada.

Dos reglas que te van a responder con error:

- Un comentario no puede quedarse **sin texto y sin imágenes**: `400`, la misma
  regla que impide publicar uno vacío.
- Cada id de `removeImageIds` tiene que ser **de ese comentario**: `400`. Ni de la
  galería ni de otra respuesta.

Y por eso `DELETE …/images/{id}` **sólo sirve para la galería**. Si la imagen
pertenece a un comentario responde `403` y te remite aquí: las imágenes de un
comentario se gobiernan por el comentario, igual que su texto.

> **Quitar una imagen no borra el fichero.** Se desprende del reporte y deja de
> servirse, pero el objeto sigue en el almacenamiento: image-service aún no expone
> un borrado. Es una fuga conocida y no un descuido — el borrado real necesita su
> propia política de retención, más ahora que cac conserva visibles los comentarios
> retirados, y sus imágenes con ellos.

### Los comentarios retirados no te llegan

Cuando alguien del equipo retira un comentario en cac, **desaparece de tu hilo por
completo** — ni el contenido ni un hueco donde estaba. Dentro de cac el equipo
sigue viéndolo, marcado, porque para ellos es parte del registro.

No tienes que filtrar nada: lo que no debes mostrar no te llega. Y tampoco cuenta
como respuesta sin leer para el reporter.

> **Enseña el botón sólo donde funciona.** El hilo mezcla comentarios de tu app, del
> equipo de cac y del reporter, así que un botón de editar en todos falla en la
> mayoría:
>
> ```js
> // Tuyo es lo que escribiste con tu key — incluido lo que relayaste del
> // reporter. Un comentario del reporter que llegó por el widget público no
> // trae externalId, y ése no es tuyo.
> const editable =
>   c.author?.kind === "tenant" ||
>   (c.author?.kind === "reporter" && !!c.author.externalId)
> ```
>
> Sin ese filtro, editar el comentario de otro responde
> **403 `only the author can modify this comment`**, y uno de sistema
> **403 `system comments are immutable`**. El servidor está haciendo lo correcto;
> es la interfaz la que ofreció algo que no existía.
>
> Si además quieres que sólo el autor real edite lo suyo, compara
> `c.author.externalId` con el id de tu sesión — cac no puede hacerlo por ti,
> porque la key es del proyecto y no de la persona.

Los borrados no destruyen: quitar un comentario lo marca junto con sus imágenes, y
quitar una imagen la marca **y deja un comentario de sistema** que lo registra. La
única operación que pierde contenido es editar, que reemplaza el cuerpo sin historial
— igual que para una persona.

---


## 4. Webhook

La forma de enterarte de lo que pasa. No hay que sondear, y **no hay SSE para keys**:
el stream en vivo es solo para personas.

Se configura por proyecto desde la app de cac: una URL y un secreto de firma.

- **Firma**: cabecera `X-Cac-Signature`, valor `sha256=<hex>`, HMAC-SHA256 del
  **cuerpo crudo**. Compáralo contra los bytes que recibiste, **antes de parsear**:
  re-serializar el JSON reordena llaves y rompe la comparación.
- **Responde siempre 200**, aunque tu manejo falle. Un 4xx se toma como "esta
  petición está mal" y no se reintenta; un 5xx sí, hasta 3 intentos con 10s de
  timeout.

Payload:

```json
{
  "type": "report:comment",
  "reportId": "...", "projectId": "...", "folio": "portento-12",
  "reporterId": "...", "reporterName": "...",
  "data": { "reportId": "...", "commentId": "...", "from": "project:portento" },
  "at": "2026-08-02T09:00:00Z"
}
```

Eventos: `report:new`, `report:status`, `report:comment`, `report:attachment`.

`report:comment` lleva además `authorName` y `authorId` en `data` cuando quien
respondió fue una persona de tu app, para que puedas atribuirla sin pedir el detalle.

Y su `from` sigue la misma regla que la clase de autor: **`"reporter"` cuando lo
escribió quien abrió el reporte**, aunque lo hayas relayado tú con la key. Por eso
descartar `project:<slug>` sigue siendo correcto y no te deja sordo a las
respuestas de tus usuarios.

Que `reporterId` venga en **todos** es deliberado: enrutar un aviso ("te
respondieron") es leer un campo, no mantener un índice local ni llamar de vuelta.

### `data.from`: ignora lo que hiciste tú

Todos los eventos lo traen. Vale `"reporter"`, `"team"` o `"project:<slug>"`.

Importa más de lo que parece: si cambias un estado con tu key, cac te dispara
`report:status` **a ti**. Sin `from` no puedes distinguir tu propia acción de la del
equipo, y acabas re-aplicando tu cambio en bucle o ignorando los ajenos.

**Regla práctica: descarta todo evento cuyo `data.from` sea tu propio
`project:<slug>`.**

---

## 5. El token del reporter

Tus usuarios no tienen cuenta en cac. Para que puedan seguir su propio reporte, el
alta devuelve un `token` por reporte: una firma HMAC, no una fila en ninguna tabla.

Guárdalo junto al id del reporte. Con él, y solo para **ese** reporte, el reporter
consulta su estado, lee el hilo y responde — sus comentarios aparecen como suyos y no
como del equipo.

> **Si integras desde tu servidor, no lo necesitas para comentar.** Manda el
> comentario por la key con `authorId` igual al `reporterId` y sale igual de
> atribuido, con la ventaja de que después puedes editarlo o retirarlo. El token
> queda para el widget público, donde reporta alguien sin cuenta.

### Cómo mandarlo

Tres formas, en este orden de preferencia:

| | |
|---|---|
| `Authorization: Bearer <token>` | lo que deberías usar |
| `X-Report-Token: <token>` | si ya usas `Authorization` para otra cosa |
| `?token=<token>` | sigue funcionando, y es lo que puede hacer un `<img>` |

**Prefiere la cabecera.** La query acaba escrita en el log de accesos del servidor
y en cualquier proxy por el que pase, con la credencial dentro. Sigue aceptada
porque el widget se publica aparte y hay copias antiguas en páginas de terceros:
quitarla las dejaría fuera.

### Dura 90 días y se renueva sola

Cuando el token que usas está **a menos de 30 días de expirar**, `GET /ingest/v1/reports/{id}`
devuelve uno nuevo en el campo `token` de la respuesta. Guárdalo en lugar del viejo
y sigue.

Fuera de esa ventana el campo **no viene**, así que no lo trates como obligatorio.
Renovarlo en cada lectura sería emitir un token por recarga de página.

**El viejo sigue valiendo hasta que expire de verdad.** Renovar no revoca: un cliente
que ignore el campo no se queda fuera a media sesión — sencillamente se le agotará el
plazo algún día, y ahí sí toca degradar a solo lectura con un aviso honesto en vez de
fallar.

---

## 5.b Reportes que levantamos nosotros

Un reporte puede nacer de tu lado —alguien lo reporta— o **del nuestro**: el
equipo abre trabajo sobre tu producto y lo pone en tu tablero para que sepas qué
se está haciendo.

Se ven y se comportan como cualquier otro reporte: tienen folio, estado, hilo y
te llega el webhook `report:new`. Dos diferencias que conviene que tu interfaz
contemple:

**`origin` puede venir como `internal`.** Antes sólo había `user` y `system`.
Es aditivo: si comparas contra `"system"` para una insignia, `internal`
simplemente no coincide y no rompe nada. Si quieres distinguirlo, ya tienes por
dónde.

**No hay reporter.** Nadie lo reportó, así que `reporterId` y `reporterName`
vienen vacíos, también en el webhook. Si tu receptor enruta las notificaciones
por `reporterId` —como hace el de portento—, **este evento no notificará a
nadie**. El reporte aparece en tu tablero igual; lo que puede faltar es el aviso.
Si quieres que llegue a alguien, enrútalo por proyecto cuando no haya reporter.

> Lo que **no** verás nunca es el trabajo que marcamos como interno: no aparece
> en tu listado, ni en tu webhook, ni en el hilo. Para ti no existe.

---

## 6. Límites de tasa

Dos, y hacen falta los dos:

| Límite | Alcance | Por defecto | Código |
|---|---|---|---|
| `rateLimitPerHour` | Todo el proyecto | 20 | `rate-limited` |
| `rateLimitPerReporterPerHour` | Una persona | 10 | `rate-limited-reporter` |

Con solo el techo de proyecto, el primero que reporte mucho gasta el presupuesto de
todos — y a quien deja fuera es justamente a quien tiene algo que reportar. El de
persona solo aplica si el reporte manda `reporterId`; sin él, gobierna el techo del
proyecto.

Ambos se ajustan por proyecto desde la app de cac.

---

## 7. Telemetría

Los campos `telemetry`, `snapshot` y `context` del alta se combinan en un solo blob,
se redactan en servidor y se guardan cifrados (AES-GCM). Vuelven **descifrados** en
el detalle, bajo la clave `telemetry`, y **solo ahí**: la vista del reporter no
expone `userAgent`, snapshot ni telemetría, por tipo y no por disciplina.

Dos cosas que hay que saber:

- **Se purgan a los 45 días.** Si necesitas conservarlos más, dilo antes de
  depender de ello.
- **Sin `REPORTS_KEK` en el despliegue de cac no se guardan.** El backend solo lo
  avisa con un warning al arrancar y el reporte se crea igual, así que el fallo es
  invisible hasta que alguien abre el detalle esperando el snapshot y no hay nada.
  Verifícalo antes del primer reporte de verdad.

---

## 8. Errores

Los que vas a ver de verdad, con lo que significan:

| Código | HTTP | Qué pasó |
|---|---|---|
| `no-key` | 401 | Falta la cabecera `X-Ingest-Key` |
| `invalid-key` / `invalid-ingest-key` | 401 | Key desconocida, o el proyecto está inactivo — no se distingue a propósito |
| `key-not-server-to-server` | 403 | El proyecto es `web`; su key no puede leer ni triar |
| `endpoint-not-key-reachable` | 403 | Ese endpoint no está al alcance de una key de proyecto |
| `origin-missing` | 403 | El proyecto tiene orígenes registrados y no mandaste `Origin` |
| `origin-not-allowed` | 403 | El `Origin` que mandaste no está en la lista |
| `rate-limited` | 429 | El proyecto llegó a su tope por hora |
| `rate-limited-reporter` | 429 | Esa persona llegó a su tope por hora |
| `not-found` | 404 | El reporte no existe **o no es de tu proyecto** — la misma respuesta, para no confirmar que existe |
| Transición inválida | 409 | Ese cambio de estado no lo permite la máquina de estados; consulta `transitions` |
| Solo el autor | 403 | Intentaste editar o borrar un comentario que no escribió tu proyecto |
| Comentario de sistema | 403 | Los comentarios de sistema son inmutables |
| Comentario vacío | 400 | Un comentario necesita cuerpo o al menos una imagen, también después de editarlo |
| `That image does not belong to this comment` | 400 | Un id de `removeImageIds` es de la galería o de otro comentario; no se aplicó nada |
| `This image belongs to a comment` | 403 | Usa el `PATCH` del comentario, no el `DELETE` de imagen |
| Almacenamiento de imágenes | 503 | image-service no está disponible; el texto sí se pudo guardar |

---

## Lista de comprobación

1. El proyecto está creado en cac con **Integration: App / server**.
2. La ingest key está guardada donde toque (se muestra una sola vez).
3. `REPORTS_KEK` está puesta en el despliegue de cac, si vas a mandar telemetría.
4. El webhook tiene URL y secreto, y tu endpoint verifica la firma **sobre el cuerpo
   crudo** y responde 200 siempre.
5. Ignoras los eventos cuyo `data.from` es tu propio proyecto.
6. Guardas el `token` de cada reporte junto a su id.
7. Lees `transitions` y `taxonomy` del servidor en vez de copiarlos.
