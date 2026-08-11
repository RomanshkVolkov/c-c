# Adoptar cac en una aplicación

Cómo se conecta una app al módulo de reportes, y cómo se muda una que ya usa el
widget. El **contrato** —endpoints, credencial, autoría, webhook, límites— vive
en [server-to-server.md](./server-to-server.md); esto es el orden en que se hace,
que es donde están las trampas.

Portento es la referencia trabajada: hizo esta mudanza entera y sus decisiones
están anotadas en su repo, en `docs/integracion-cac.md`.

---

## 1. Elige la forma antes que nada

Hay dos, y no es una preferencia de estilo: **determinan qué puede hacer la
credencial**.

| | `platform: web` (widget) | `platform: app` (server-to-server) |
|---|---|---|
| Dónde vive la key | en la página, pública | en tu servidor, secreta |
| Qué alcanza | **sólo crear** reportes | crear, leer, responder y triar |
| Quién reporta | cualquiera, sin cuenta | tus usuarios, con la identidad que tú afirmas |
| Qué la protege | lista de orígenes + límite de tasa | que la key nunca sale de tu servidor |

**La regla que decide:** ¿el formulario está detrás de un login?

Si lo está, **server-to-server, siempre**. Un widget público detrás de una
sesión paga el precio de seguridad de la anonimia sin comprar nada a cambio:
tus reporters ya están identificados, y tú ya tienes un servidor que puede
guardar un secreto.

El widget es para lo que no puede ser de otra forma: una página pública, alguien
sin cuenta.

### Por qué la key de un proyecto `web` no puede leer

cac lo rechaza explícitamente (`middleware/report_key.go`). Esa key viaja dentro
del JavaScript que descarga el navegador — es pública por construcción, y abrir
las herramientas de desarrollo basta para tenerla.

Que pudiera **crear** un reporte es un riesgo acotado: lo peor es ruido contra un
límite de tasa. Que pudiera **leer** sería entregar todos los reportes del
proyecto a quien mire el código fuente. Por eso son dos cosas distintas y no un
interruptor de confianza.

---

## 2. Mudar un widget a server-to-server

El orden importa, y hay un paso que **no** se puede adelantar.

> **No cambies el proyecto a `platform: app` mientras el widget siga montado.**
>
> Ese cambio hace dos cosas a la vez: exime al proyecto de la regla de orígenes
> y habilita lectura y triage con su key. Si la key todavía está en el navegador
> —una `NEXT_PUBLIC_*` o equivalente—, acabas con una credencial pública que lee
> y modifica todos tus reportes. Es exactamente la combinación que el rechazo
> del punto anterior existe para evitar.

Secuencia sin ventana de riesgo:

1. **Escribe el cliente en tu servidor.** Con la key en una env de runtime, no
   de build. Contrato en [server-to-server.md](./server-to-server.md).
2. **Pinta el tablero y el hilo en tu propia interfaz**, leyendo de cac.
3. **Quita el widget** y su `NEXT_PUBLIC_*`. Ya nada del navegador lleva la key.
4. **Ahora sí, cambia el proyecto a `app`** en la consola y rota la key — la
   anterior estuvo publicada, dala por comprometida.

Cambiar la plataforma **al final** conserva el historial: los reportes que ya
existen siguen en el mismo proyecto. Crear un proyecto nuevo también evitaría la
ventana de riesgo, pero parte el tablero en dos.

---

## 3. Lo que hay que registrar

Tres variables, todas de runtime:

| | |
|---|---|
| `CAC_BASE_URL` | pública; una variable, no un secreto |
| `CAC_INGEST_KEY` | secreto. Se muestra **una sola vez** al crear el proyecto; después sólo se puede rotar |
| `CAC_WEBHOOK_SECRET` | secreto, ≥16 caracteres, si vas a recibir webhook |

Y una del lado de cac, no tuyo: `REPORTS_KEK`. Sin ella la telemetría de los
reportes **no se guarda** y el fallo es silencioso — el reporte se crea igual.
Se comprueba en el log de arranque: `telemetry encryption enabled`.

---

## 4. Lo que se aprende una sola vez

Cosas que costaron tiempo en la primera integración y no tienen por qué costarlo
otra vez.

**No mandes `projectId`.** El servidor lo impone desde la key. Uno ajeno no da
error: da lista vacía, para no confirmar que ese proyecto existe.

**Consume `transitions` y `taxonomy` del servidor** en vez de copiar las listas.
Es la diferencia entre una fuente y dos que se separan — y ya pasó una vez.

**El `author` de un comentario es un discriminador, no una etiqueta.** Manda
sobre el nombre: al propio reporter se le dice «tú», no su nombre. Invertirlo es
un error fácil y se ve raro.

**Editar un comentario es una operación, no tres**, y va en multipart aunque no
lleve imágenes.

**Un reporte de sistema** (`origin=system`) dedup por título contra los abiertos
del proyecto, para que un proceso que reintenta no inunde el tablero.

---

## 5. Antes de dar por hecha la migración

- Un reporte creado desde tu app aparece en la consola con el folio correcto.
- Un comentario tuyo se lee con tu nombre en cac y como «equipo» para el reporter.
- El webhook llega firmado y **ignoras los eventos que causaste tú** (`data.from`),
  o te notificarás a ti mismo en bucle.
- La telemetría del reporte tiene contenido — si no, mira `REPORTS_KEK`.
- La key vieja está rotada.
