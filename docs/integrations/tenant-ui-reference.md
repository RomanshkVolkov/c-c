# La interfaz de un inquilino, como referencia

Qué pantallas hay que construir en tu app cuando reemplazas el widget por
server-to-server, y por qué cada una existe. Sacado de portento, que es la
integración completa: [contrato](./server-to-server.md) ·
[cómo se adopta](./adopting-cac.md).

No es una guía de estilo. Los colores y los componentes son tuyos; lo que se
repite entre proyectos es **la estructura y las decisiones**.

---

## Las piezas

Cinco, y ninguna es opcional si quieres paridad con el widget.

```
libs/services/cac-reports.ts        el cliente: un solo sitio que habla con cac
libs/services/cac-reports.lib.ts    tipos y helpers puros (folio, estados, actor)
app/bug-tickets/                    triage — el tablero del equipo
app/my-bug-tickets/                 lo mío — lo que yo reporté
api/webhooks/cac-reports/           enterarse de lo que pasa allá
app/bug-tickets/[id]/images/[id]/   proxy de imágenes
```

### 1. Un solo cliente

Todo lo que llama a cac pasa por un módulo, **de servidor**. Ahí vive la key, el
lector del sobre `{success, data}` y el manejo de error; ningún componente sabe
que cac existe.

Portento expone unas quince funciones: alta, listar, detalle, patch, comentar,
editar y retirar comentario, adjuntar y quitar imagen, transiciones, taxonomía,
traer imagen.

**Por qué una capa y no llamadas sueltas:** la key no puede filtrarse al cliente
ni por accidente. Si sólo un módulo la lee, revisar eso es mirar un fichero.

### 2. Dos pantallas, dos audiencias

Esto es lo que más se copia mal, así que va explícito:

| | quién entra | qué ve |
|---|---|---|
| `/bug-tickets` | **sólo el rol que tría** — portento comprueba el rol y devuelve 404 si no | tablero kanban de todo el proyecto, detalle, cambiar estado, responder |
| `/my-bug-tickets` | cualquier usuario con sesión | **sólo sus propios reportes**, con el hilo |

La segunda es la que sustituye al widget. Sin ella, quien reporta un fallo no
vuelve a saber de él — y eso era justo lo que el widget sí daba.

El filtrado de «lo mío» se hace con `?reporterId=` contra cac, usando el id de
**tu** sesión. cac no tiene cuentas de tus usuarios: la identidad la afirmas tú
en cada llamada.

### 3. El tablero

Kanban con las columnas del estado. Dos cosas que no son evidentes:

- **Las transiciones válidas se piden a cac** (`/reports/transitions`), no se
  copian. Un movimiento ilegal lo rechaza el servidor con 409, así que el
  tablero debe preguntar antes de ofrecer el destino.
- **Las categorías y prioridades también** (`/reports/taxonomy`). Copiarlas fue
  exactamente el error que ya se cometió una vez.

### 4. El proxy de imágenes

Las imágenes de un reporte **no se pueden enlazar directamente**: cac las sirve
tras autenticación, y un `<img>` del navegador no puede mandar la key.

Portento pone una ruta propia: el navegador pide
`/bug-tickets/{id}/images/{imageId}`, el servidor la trae de cac con la key y la
devuelve. La autorización de quién puede verla se hace ahí, con tu sesión.

### 5. El webhook, que es la única vía

> **No hay stream en vivo para una key.** El SSE de cac es sólo para personas con
> sesión en la consola. Sin webhook, tu app no se entera de nada.

Tres cosas que costaron sangre y están en el receptor de portento:

**La firma se calcula sobre los bytes crudos.** Comparar contra el JSON
re-serializado no funciona: reordena las llaves y rompe el HMAC. Hay que leer el
cuerpo como texto antes de parsearlo.

**Compara en tiempo constante**, y ojo con que `timingSafeEqual` exige la misma
longitud — una distinta ya es inválida y hay que comprobarlo antes.

**Ignora lo que causaste tú.** Cada evento trae `data.from`; si no lo filtras, tu
app se notifica a sí misma cada vez que responde un comentario.

---

## El punto de entrada al reportar

El widget traía un botón flotante. Al quitarlo, hay que poner algo en su lugar
o los reportes dejan de llegar — es el paso que más fácil se olvida, porque nada
falla: simplemente se hace el silencio.

Portento lo resolvió con un formulario propio, que además pudo hacer algo que el
widget no: **prellenar contexto que sólo la app conoce** —qué pantalla, qué
registro, qué usuario— en vez de depender de que lo escriba quien reporta.

Y la identidad va como `reporterId` + `reporterName`. Eso es lo que hace que
después `/my-bug-tickets` pueda filtrar, y que la respuesta del equipo le llegue
a alguien.

---

## Lo que se gana al dejar el widget

No es sólo seguridad. Merece decirse porque justifica el trabajo:

- **Contexto**: el formulario sabe dónde estaba el usuario.
- **Identidad real**: la de tu sesión, no la que alguien teclee.
- **Editar y retirar** tus propios comentarios, que el token del reporter no
  permite.
- **Tu interfaz**: el hilo se ve como tu producto, no como un widget incrustado.
- **La key deja de ser pública.**

## Lo que se pierde

- **Reportar sin cuenta.** Si necesitas eso en una página pública, el widget
  sigue siendo la respuesta correcta — con su propio proyecto `platform: web`.

---

## Lo que haría distinto

Todo lo de arriba describe una integración que funciona en producción. Esto es
opinión, marcada como tal, para que la siguiente no repita lo que se puede
mejorar.

### Responde rápido y trabaja después

cac espera la respuesta del webhook con un timeout, y **reintenta** ante 5xx o
error de red. Si el receptor manda notificaciones antes de contestar, un pico de
lentitud se convierte en un reintento — y en notificaciones duplicadas.

Contesta 200 en cuanto valides la firma, y haz el trabajo después.

### Deduplica por `eventId`

El payload trae un `eventId` que es **por evento, no por intento**: los
reintentos de un mismo evento lo repiten. Guarda los que ya procesaste y
descarta los repetidos.

Esta integración se escribió cuando ese campo no existía y aquí decía que
guardaras una huella de tipo + reporte + `at` durante unos minutos. **Eso ya no
hace falta, y además fallaba** si dos eventos legítimos del mismo tipo caían en
el mismo segundo. Si lo tienes puesto, se puede quitar.

### Que el webhook refresque el tablero, no sólo notifique

Sin stream en vivo, el tablero se queda como estaba hasta que alguien recargue.
El webhook ya te está diciendo que algo cambió: aprovéchalo para invalidar la
caché de esa vista. Es la diferencia entre un tablero que se actualiza solo y uno
que miente hasta el próximo F5.

### Cachea el proxy de imágenes

Cada render de una tarjeta con miniatura vuelve a pedir la imagen a cac. Son
bytes inmutables: un `Cache-Control` largo y un `ETag` quitan casi todo ese
tráfico, y la autorización sigue haciéndose en tu ruta.

### Distingue el 429

Un límite de tasa alcanzado no es «no se pudo enviar». Si se muestra como error
genérico, quien reporta lo intenta otra vez y empeora justo lo que lo causó.
Dilo: «demasiados reportes en la última hora, inténtalo más tarde».

### El `reporterId` sale de la sesión, nunca del cliente

Suena obvio y es la clase de cosa que se rompe en una refactorización: si ese id
llegara en el cuerpo de una petición del navegador, cualquiera podría leer los
reportes de otro pidiéndolos con su id. Que salga de la sesión en el servidor, y
que no exista un camino donde lo aporte el cliente.
