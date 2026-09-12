# Adoptar cac en una aplicación

Cómo se conecta una app al módulo de reportes. El **contrato** —endpoints,
credencial, autoría, webhook, límites— vive en
[server-to-server.md](./server-to-server.md); esto es el orden en que se hace,
que es donde están las trampas.

Portento es la referencia trabajada: hizo esta integración entera y sus
decisiones están anotadas en su repo, en `docs/integracion-cac.md`.

---

## 1. Sólo hay una forma, y por qué

Tu servidor guarda una key y habla con cac. La key **nunca** sale de ahí: no
viaja al navegador, no entra en una `NEXT_PUBLIC_*`, no se compila dentro de un
bundle. Con eso alcanza a crear, leer, responder y triar los reportes de su
proyecto.

Hubo una segunda forma —un widget embebible con la key dentro de la página— y se
retiró el 11-sep-2026. Vale la pena saber por qué, porque explica el diseño que
queda:

Una key que viaja en el JavaScript que descarga el navegador es **pública por
construcción**: abrir las herramientas de desarrollo basta para tenerla. Que
pudiera *crear* un reporte era un riesgo acotado —lo peor es ruido contra un
límite de tasa—. Que pudiera *leer* habría sido entregar todos los reportes del
proyecto a quien mirase el código fuente. Por eso aquella key era de sólo
escritura, y por eso hacían falta dos clases de proyecto.

Lo que la guardaba era una lista de orígenes permitidos, y ahí estaba la grieta:
la comprobación **se saltaba entera** para cualquier petición que no mandara
cabecera `Origin` — o sea, para cualquier `curl`. Era un trato aceptado a
sabiendas mientras la key fuese de sólo escritura.

Sin navegador no hay nada de eso: una sola clase de proyecto, una sola clase de
key, y ninguna lista de orígenes que mantener.

→ Guardián: `middleware.TestNoSecondClassOfProjectKeyComesBack`.

---

## 2. Tu interfaz, contra el contrato

cac no pinta nada para tus usuarios. El tablero, el hilo del reporte y la
pantalla de «mi reporte» los construyes tú, leyendo de cac. Las pantallas y las
decisiones que ya se tomaron una vez están en
[tenant-ui-reference.md](./tenant-ui-reference.md).

Para la vista del reportero, la ingesta te devuelve un `token` por reporte en la
respuesta de creación: guárdalo y con él tu usuario puede ver el suyo y
responder, sin cuenta en cac.

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
