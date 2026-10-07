# cac — lo que hay que saber antes de tocar

Monorepo: `app/` (Tauri 2 + React 19, el cliente de escritorio), `backend/` (Go +
chi + GORM + Postgres, la API en `cac.guz-studio.dev`), `swarm-manage/` (agente
por host), `infra/`.

Los comentarios del código de este repo son buenos y explican el *por qué*. Aquí
sólo va lo que no cabe en un comentario porque no tiene un sitio único donde
vivir. Lo demás, léelo donde está.

## El método de la casa: mutar toda prueba nueva

Una prueba que no se ha mutado no se sabe si prueba algo. Escribe la prueba,
rómpele el código a propósito, y comprueba que la prueba se queja. Es lo que ha
encontrado los fallos de verdad en este repo — hay comentarios que lo dicen por
su nombre (`meeting_rule_test.go`, `report_project_patch_test.go`,
`useEncogerEnLlamada.test.tsx`, `locale-sync.test.ts`).

Hay una skill para el ritual: `/mutar`. **Un mutante vivo se investiga, no se
ignora.**

## Las trampas que ya han mordido

**Hay dos máquinas de estados, no una.** `ReportStatus.CanTransitionTo` sólo
conoce el estado, así que sólo puede contestar por la del **cliente**, que es
estricta a propósito. Lo que hay que preguntar es
`domain.CanTransition(ficha.Flow(), from, to)`. Aplicarle la estricta a una tarea
interna deja botones que no hacen nada y no dicen por qué — así se murió el check
de las subtareas. Ver `backend/internal/core/domain/report.go` (sección «Dos
máquinas, y por qué»).

**En el flujo del cliente, `pending → resolved` no existe**: hay que pasar por
`in_progress`. Mover directo devuelve 409. En el interno se puede ir de cualquier
sitio a cualquier sitio, y **cerrado no es terminal**.

**Una subtarea siempre es interna**, porque `CreateTask` le borra el `ProjectID`
al crearla (no gastar un folio del cliente en una línea de checklist). De eso
depende que el check de «hecho» funcione: salta de Open a Done, que sólo es legal
en el flujo interno.
→ Guardián: `domain.TestUnaSubtareaEsInterna` y `service/subtarea_interna_test.go`.

**`dueAt` es una fecha guardada como instante.** Léela con `dueDay`
(`app/src/lib/month.ts`). Con los captadores locales (`getDate()`, etc.) el día se
corre un día al oeste de Greenwich. `dayKey` **también** es local: no la
uses sobre un instante crudo. Así pintó el calendario de «Mi trabajo» en el 29
lo que se soltó en el 30. Por eso `CalendarItem` obliga a elegir entre `day`
(una fecha) y `at` (un instante): un vencimiento va como `day`; pasarlo como
`at` compila y vuelve a fallar.
→ Guardianes: `app/src/lib/month.test.ts` y `ItemCalendar.test.tsx` («en qué
día cae»).

**Las pruebas de la app corren en `America/Mexico_City`**, fijado en el script
`test` (no en `vitest.config.ts`: Node lee la zona al arrancar y `test.env`
llega tarde). Sin eso corrían en la zona de la máquina, y en UTC un fallo de
zona es invisible. Si tocas fechas, pasa `bun run test:timezones`: la suite bajo
UTC, UTC−6 y UTC+13. Con una sola zona, un fallo simétrico al revés sigue
escondido — el primer barrido encontró uno en `meeting-time.test.ts`.

**Un token personal es la persona para los scopes, pero no para firmar.** Sus
claims copian `Superadmin` del usuario, así que «¿es superadmin?» no distingue
a la persona de un agente con su token. Lo que tiene que hacer una persona en
persona —hoy, firmar la revisión de un doc— se decide con `ViaToken`, que sólo
pone la rama PAT de `AuthMiddleware` y nunca viaja en JSON. Hasta el 27-sep-2026
un comentario aseguraba que ningún token podía firmar, y el de un superadmin
firmaba (#84).
→ Guardianes: `domain.TestDocReviewSigner`, `TestViaTokenNeverTravelsInJSON` y
`middleware.TestAPersonalTokenIsMarkedAsOne`.

**La prioridad media se guarda `medium` y se contesta `normal`.** `normal` es
sólo como la pide y la devuelve la API de tareas (`TaskWire`); en la base es
`medium`. Una consulta que ordene o filtre por prioridad pregunta por el nombre
**guardado**. El orden de «mi trabajo» preguntaba por `normal` y ponía casi todas
las tareas por debajo de las de prioridad baja; y editar guardaba la entrada
cruda, así que convivían los dos nombres (#83). Todo lo que escribe prioridad
pasa por `Canonical()`.
→ Guardianes: `service.TestMyWorkPutsMediumBetweenHighAndLow`,
`TestEditingAPriorityStoresWhatCreatingStores` y
`repository.TestNormalPrioritiesBecomeMediumAndNothingElseMoves`.

**Un nombre para enseñar sale de `nombreVisible`**
(`backend/internal/core/repository/nombres.go`), nunca de `username` a mano: un
identificador de acceso no es cómo se llama a una persona. Buscar, mencionar e
identificar sí van por `username`.
→ Guardián: `repository.TestNadieResuelveElNombreASuAire` y `nombres_sql_test.go`.

**Un egress muerto sigue diciendo que está vivo.** Si el pod de `livekit-egress`
se cae, LiveKit deja el registro en `EGRESS_ACTIVE` **para siempre**: ni el
estado, ni `updated_at` —que no late ni con el egress sano—, ni la presencia del
participante en la sala lo delatan. Las tres se midieron contra el SFU. Lo único
que lo distingue es pedirle que pare: 408 `deadline_exceeded` si no hay nadie,
412 `failed_precondition` si ya terminó. Y como preguntar **es** parar, sólo se
pregunta al cerrar; mientras se graba, un pod que muere no se detecta y se
acepta. Contar el 412 como muerte tira grabaciones buenas.
→ Guardianes: `service.TestADeadEgressWorkerDoesNotHangTheRecording` y
`TestAStaleListingDoesNotKillAFinishedTrack`. El porqué entero, con los números,
en `docs/grabacion.md`.

**La medida de lectura de un documento (68ch) es para la prosa**, no para tablas
ni bloques de código: puesta al cuerpo entero, una tabla ancha «cabe» partiendo
las palabras a mitad y su propio deslizamiento no se activa nunca.
→ Guardián: `app/src/components/markdown/enlaces.test.tsx` («la medida de
lectura de un documento»).

**Un aviso del sistema no le pregunta al foco.** Tener la ventana con el foco no
es estar mirando eso. La puerta que había («si tiene el foco, no avises») está
quitada a propósito; no la vuelvas a poner.
→ Guardián: `app/src/hooks/avisos-del-sistema.test.tsx` («la puerta del foco»).

**El rango de un tablero es un `NUMERIC`, y tiene que seguir siéndolo.** Hasta
el 10-sep-2026 era texto en base 62 (`0-9A-Za-z`) y lo ordenaba Postgres con
`ORDER BY rank`, así que el orden dependía de la colación: con una de locale
(glibc `en_US.utf8`) las cajas se entremezclan y **el segundo elemento de un
contenedor se pinta antes que el primero** —los primeros rangos eran «U» y «k»—.
Producción estaba en `C` y acertaba, pero nada en el esquema lo pedía. A un
número no hay colación que aplicarle. Devolver la columna a `varchar`
reintroduce el fallo entero **sin romper ninguna otra prueba**, porque en una
base `C` seguiría saliendo bien.
→ Guardián: `repository.TestEveryRankColumnIsNumeric`. Y una fila sin rango no
revienta la inserción porque la columna tiene `default:0.5`; los caminos que
saben dónde va la tarjeta le ponen el suyo.

**El webview de Linux es WebKitGTK, y no se porta como Chrome.** Lo que
funciona en la web (o en WhatsApp Web) puede no funcionar en la app. Soltar un
fichero desde Thunar escribía su ruta en el mensaje por tres cosas que **no
están documentadas juntas en ningún sitio**: WebKit no entrega el `drop` si el
`dragover` no dice `dropEffect = "copy"` (ProseMirror lo cancela, pero no basta);
deja `text/uri-list` **vacío** (no enseña rutas `file://` a una página); y la
ruta sólo viaja como **texto** de un `<a>` sin `href` en el `text/html`. Los
bytes los lee Rust (`read_dropped_file`), sólo de tipos que se adjuntan y
mirando la ruta real (un enlace simbólico `foto.png` → `~/.ssh/id_rsa` no
pasa). Ante algo así, **un log temporal primero** de lo que llega de verdad, no
hipótesis.
→ Guardianes: `app/src/lib/dropped.test.ts` (lleva el HTML real que entregó
WebKitGTK) y `dropped::tests` en `app/src-tauri/src/dropped.rs`.

**Un esquema propio es otro origen.** `cacmedia://` y `cacvideo://` los sirve
Rust, y para el webview son **otro origen**: un `<img>` carga igual, pero un
`fetch` sin `Access-Control-Allow-Origin` falla con «estado 0». pdf.js descarga
con `fetch`, así que el visor de PDF del escritorio **no abrió nunca nada** hasta
el 6-oct-2026. Toda respuesta de un esquema propio lleva la cabecera, también
las de error.
→ Guardián: `media::tests::every_answer_can_be_read_by_a_fetch`.

**La CSP del escritorio bloquea en silencio.** Desde la v1.6.89 la app tiene
CSP (`app/src-tauri/tauri.conf.json`). Algo que no esté permitido no da error:
simplemente no carga. Cada fuente permitida está atada a lo que la usa; si
añades un sitio nuevo al que la app hable o del que cargue, añádelo ahí y en la
prueba, y pruébalo con la app abierta, no sólo con vitest.
→ Guardián: `app/src/lib/desktop-csp.test.ts`.

**Un contenedor que se llena a mano no puede tener hijos de React.** El visor
de PDF dibujaba las páginas en el mismo `<div>` donde React ponía «Cargando…»;
al vaciarlo se llevaba ese `<p>` y React fallaba después con
`NotFoundError: The object can not be found here.` Lo mismo con montar React
dentro de una decoración de ProseMirror durante el render de otro árbol: se
monta en una microtarea, después.
→ Guardianes: `app/src/components/PdfPreview.test.tsx` y
`app/src/components/markdown/pdf-cards.mount.test.tsx`.

## El CI corre las pruebas de backend, app, transcriptor y agente

Las cuatro suites corren **por delante** de lo que publican, así que rojo no sale:

| Workflow | Qué corre | Qué frena |
|---|---|---|
| `backend.yml` | `go test` con Postgres de verdad | el despliegue a producción (#38) |
| `app.yml` | tipos, eslint, y la suite **bajo las tres zonas** | la release: `app-release.yml` lo llama antes de compilar (#69) |
| `transcriber.yml` | `pytest` | la imagen del worker |
| `swarm-manage.yml` | `go test` del agente | su imagen (`:vN` desde `swarm-manage/VERSION`) |

Al encender cada una salió algo que llevaba tiempo escondido: una prueba del
backend roja desde hacía meses, y en la app un error huérfano de tiptap que hacía
salir la suite con código 1 con todo en verde (tapado en `test-setup.ts`).

**Sin red sigue** el lado Rust de la app, que no tiene pruebas propias en el CI:
lo único que lo comprueba es que la release compile en las tres plataformas.

Una release con `app.yml` en rojo **se queda publicada sin instaladores**. El
actualizador no se entera, así que nadie se la come, pero esa versión ya está
gastada: se arregla y sale la siguiente.

Y ojo con el verde de `go test` **en local**: las pruebas que necesitan Postgres
se **saltan** sin base (`t.Skip("no database configured")` cuando no hay
`DB_HOST`), y son treinta ficheros. Sin `DB_HOST` puesto, un verde no significa
que se hayan corrido todas — en CI ya no puede pasar, en tu máquina sí.

## El agente de cada servidor tiene identidad (desde su v2)

`swarm-manage` abre el socket de Docker de la máquina: su API es la puerta de
toda la VPS. Desde la v2 **no abre `/api/v1` sin identidad** —un token por
servidor que acuña el backend y una llave de sesión derivada, instalados como
Docker secrets por stdin— y cada petición de la app lleva un pase firmado. No
hay modo abierto al que caer; sin secrets contesta 503.
→ Guardianes: `TestNoAgentRouteWithoutAuth` (recorre el router del agente con
`chi.Walk`), `TestSessionVector` / `TestAgentSessionVector` (el **mismo**
vector en el agente y en el backend: si cambias uno, cambia el otro) y
`la_imagen_es_la_version_del_agente` (la app clava la versión que publica el
workflow).

Y el agente **actualiza servicios con `service update` por la API de Docker,
nunca con `stack deploy`**: un stack que creó el CI de un proyecto no se recrea
y conserva labels, redes y secrets. Es lo que permite que cada proyecto se sume
a los despliegues por cac cuando quiera.

## La puerta de verificación

Entera, antes de dar algo por hecho. Desde la raíz del repo:

```sh
(cd app           && npx tsc --noEmit)                            # tipos
(cd app           && bun run test)                                # eslint + vitest
(cd app/src-tauri && cargo check)                                 # el lado Rust
(cd backend       && go build ./... && go vet ./... && go test ./...)
```

## Soltar una release

Hay skill: `/soltar`. El orden importa y no perdona: **el backend despliega antes
que la app**. Al revés, una app nueva habla con un servidor que no la entiende y
quien actualiza rápido se come el rato. La versión es siempre la **siguiente**;
nunca se re-corta una publicada.

## Convenciones

- **El código se escribe en inglés y se comenta en castellano.** Ficheros,
  funciones, tipos, variables y campos: inglés. Comentarios y prosa: castellano.
- **No imitar los nombres en castellano que ya existen.** Hay muchos
  —`nombreVisible`, `bandeja.ts`, `subtarea_interna_test.go`,
  `TestElTimbreSuenaEnUnSoloEscritorio`— y son deriva, no la convención. Copiar
  lo de alrededor es exactamente cómo se sigue mezclando. En código nuevo,
  inglés sin excepciones; y lo que ya está se renombra **al pasar por el
  fichero**, no en una barrida.
- **El texto que lee una persona no es código**: va en su idioma, y vive en los
  catálogos de `app/src/locales/`, nunca en un identificador.
- Commits de una sola línea, sin trailers ni líneas de atribución, firmados.
- Se commitea directo a `main`.
- `STATUS.md` es el doc de seguimiento: actualízalo al empezar o terminar algo,
  o al cambiar de rumbo.

## Y esto no obliga a nada

Un `CLAUDE.md` es una nota, no un guardián. Lo que obliga son las pruebas — por
eso las reglas de arriba que ya tienen una la citan al lado: para que quien las
cambie sepa qué se va a romper y por qué existe. Si añades una regla aquí sin
prueba, es un recordatorio; si te importa de verdad, escríbele la prueba.
