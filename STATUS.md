# STATUS

Tracking doc — open items, in-progress work, and decisions from rolling conversations. Update this file when you start/finish work or change direction.

## ⚠️ Los pendientes viven en cac

El 26-sep-2026 se auditó esta sección y **sus tres filas eran falsas**: pedía
verificar una versión que ya no era la última, hacer *merge* de un PR que nunca
existió (aquí se commitea directo a `main`), y un botón «Update Agent» que llevaba
en la app desde el 9-jun. Un pendiente tiene estado, dueño y fecha, y eso es un
tablero: **App** `ca0bfd49-0909-43eb-8135-bc8ecd0f282c` y **Backend**
`91abe433-4d90-4519-93ff-616109ce40c9`, en «Command and control».

## 🟢 Al día

**Hecho, sin commitear (7-oct): Diagnóstico para ver bien la telemetría de
cualquier app** (tarea `8709d4d4`, en TDS; análisis de los 9 puntos comentado
ahí). Genérico: lo propio de cada app lo dice el lote (`device.label`,
`device.subject`, nunca un correo) o el proyecto (Integraciones › Telemetría:
retención 1–90 días, reglas de salud, latido con `activeWhen`). Backend:
`telemetry_devices` (búsqueda, paginación, versión del último lote), gravedad
única (`domain.CrumbSeverity`), ficha con alertas, timeline con filtros, purga
por proyecto y el **vigilante** (cada 5 min, compare-and-swap para que dos
réplicas no avisen dos veces; campana + aviso en vivo, interruptor
`telemetryQuiet`). App: pantalla nueva (lista, ficha en árbol, tira de
latidos con huecos, timeline plano por `ts`). MCP: `list_devices` con
`query`, `get_device_timeline` con `since`/`types`/`minSeverity` y resumen de
ficha y latidos. Contrato en `docs/integrations/telemetry.md`. **Falta**: el lado de
GEOCHECK (su API Go: quitar `firebaseEmail`, mandar `label`/`subject`, los
`warn` de dispositivo como `lifecycle`), commitear y soltar (backend primero).

**En curso (30-sep, #106 con R0–R8 en #107–#115): módulo de servidores** —
deploys desde cac, GitHub App, Ansible desde la app y secrets por referencia a
1Password, con adopción gradual por proyecto. **R0–R2 publicadas** (v1.6.76 y
v1.6.77, agente `:v3`): desplegar un commit y volver atrás desde cac, con
historial y log en vivo, por `service update`. **R3 publicada** (`4f954cc`,
backend desplegado; la UI en la v1.6.78): el CI avisa con una llave por
servicio (`POST /ingest/v1/deploys`); en «Apuntar» cac lista las versiones, en
«Desplegar» las despliega. Contrato en `docs/integrations/deploys.md`. **R4
commiteada** (`82c7fb2`, sale en la v1.6.79): cada servidor se abre por su URL
con pestañas, sin `state` del router. **R5 publicada en backend** (`7dc58d3`):
la GitHub App; los commits y PRs que nombran una tarea dejan una línea
interna. **R6 publicada en backend** (`b9781f5`): la App escribe en GitHub —cada deploy es
un Deployment que sigue su estado, y uno que sale bien avisa a las tareas que
trae— y el workflow que publica la imagen cuenta como el aviso del CI. R4–R6
publicadas en la v1.6.79. La App está registrada (`command-and-control-rv`, App ID
5155881) y sus cuatro variables y secrets están en el repo.
**Hecho, sin commitear (1-oct), lo que pidió jose tras la v1.6.79:**
acuñar la llave del CI la guarda sola como `CAC_DEPLOY_KEY` en el repo (con el
PAT de la app; el repo, del servicio o deducido de la imagen), y el deploy se
elige de los últimos commits del repo, marcando los que tienen imagen. Y el
error de `op read` cuando 1Password no contesta ahora dice qué hacer. Y una
ventana de una copia de cac que el actualizador ya borró lo avisa con un botón
de reiniciar (`StaleBinaryNotice`): 1Password le corta con `InvalidClientInfo`.
Y los servicios con tags cortos (RRHH etiqueta con `--short=7`): el aviso de
la App llega con el sha entero, y cac recorta al tag que existe
(`Deployable.ShortTags`). Publicado en la v1.6.80.

**R7 publicada en la v1.6.81:** Ansible desde la app. Pestaña
«Provisioning» del servidor: se elige la carpeta del repo de Ansible, el
playbook (de su `cac.playbooks.yml` o de sus carpetas), contra qué host o grupo
y sus variables. Corre aquí (`src-tauri/src/ansible.rs`): lo de 1Password se lee
en Rust y se tacha de la salida, y variables y contraseña de sudo van en un
fichero `0600` (`-e @fichero`), nunca en la línea de comandos. A cac sólo llegan
nombres, el PLAY RECAP y la cola. Manifests escritos (sin commitear, en sus
repos): `ansible/contabo/cac.playbooks.yml` y
`valkey/infra-valkey-swarm/cac.playbooks.yml`.

**R8a publicada en backend** (`5812751`)**: secrets por referencia a
1Password.** En la pestaña Secrets, por servicio: `NOMBRE` ← `op://…` (se
importan de un ítem), «Probar» y «Rotar en el servidor». Rotar lee en Rust y
manda un guion por `bash -s` (stdin): secrets de Docker versionados por HMAC
(clave en `~/.cac/` del servidor), `service update --secret-rm/--secret-add`,
conserva la versión anterior y sólo imprime nombres. Sólo en servicios que
despliega cac. A cac llegan nombres (`DeployableSecretRef`, `SecretRotation`;
una petición con un valor se rechaza). **Falta la R8b:** migraciones antes del
deploy (agente v4). Backend primero.

**R8b publicada (v1.6.82, agente `:v4`): migraciones.** Un
comando por servicio que corre antes de cada deploy como job de Swarm
(`replicated-job`) copiado del servicio, con la imagen nueva; si falla, el
servicio no se toca. A un agente < v4 no se le encola. Publicar: backend →
agente `:v4` (`swarm-manage.yml`) → app v1.6.82 (R8a + R8b), y luego «Update
agent». Ver `docs/integrations/deploys.md` §5.

**En curso (4-oct, #124 backend / #125 app): R9 — Actividad de CI.** jose
pidió aviso de **cualquier** GitHub Action de los repos de la org (quién,
cuándo, qué desplegó) y ver su estado en cac. Decisiones: todos los runs
completados a la campana, plegados por repo y con interruptor «CI y deploys»;
página propia `/activity` (runs y deploys por tiempo, filtrable por repo y
servicio, con acceso directo desde el servicio); aviso a toda la org; sólo
repos con org. **Backend hecho, sin commitear:** cada `workflow_run` de un repo
de la org se apunta en `workflow_runs` (una fila por intento, upsert por rango
de estado: un webhook tardío no deshace un `completed`), el deploy que encola
la App nace con `WorkflowRunID`, `GET /organizations/{id}/activity` mezcla las
dos tablas en el servidor con cursor `(at, id)`, y la campana recibe `ci:run`
(al terminar, a toda la org, plegado por repo) y `deploy:done` (al acabar, a
todos menos quien lo pidió, plegado por servicio), con `CIQuiet` invertida
como `WorkQuiet`. Límite conocido: no hay mapa login↔usuario, así que un run
avisa también a quien hizo el push. Plan en
`~/.claude/plans/joyful-dazzling-meteor.md`. **App hecha, sin commitear
(#125):** página `/activity` (entrada «Actividad» en Plataforma; filtros
`?repo=` y `?deployable=`; `?run=`/`?deployment=` resaltan la fila; en vivo por
`ci:run` y `deploy:status`), clases `ci:run`/`deploy:done` en la campana
plegadas por repo y por servicio, interruptor «CI y deploys» (`ciQuiet`,
invertido), accesos directos desde el diálogo de deploy, la sección del CI y
la pestaña GitHub de la org, y la lista del `EventSource` del navegador
completada. Sale **después** de desplegar el backend, en la siguiente versión.

**En curso (5-oct, #127): cac en el navegador.** Plan en
`~/.claude/plans/joyful-dazzling-meteor.md`: el mismo React de `app/` con un
segundo build (`bun run build:web`, `base: /app/`) servido por nginx en
`cac.guz-studio.dev/app`; después push al teléfono (W2), invitados a llamadas
(W3) y enlaces públicos de lectura (W4). **W0 y W1 hechos, sin commitear:**
refresh con estado (`RefreshSession`: se canjea una vez, margen de 1 min,
reúso fuera del margen revoca la sesión, `/auth/logout` la cierra, los de
antes se adoptan una vez), sólo un 401 del refresh cierra sesión en la app,
`lib/platform.ts` (`isTauri`, `isWebBuild`, `openExternal`), páginas de
escritorio en `lazy` y fuera del build web, menú web sin servidores ni
herramientas, voz desactivada en web hasta W3; `app/web/` (Dockerfile, nginx,
k8s con HTTPRoute propia en `/app`) y `.github/workflows/web.yml`.
**W0 y W1 publicados** (`e30709b`, `69494e8`): la web ya vive en `/app`.
**W2 hecho, sin commitear:** la campana al teléfono por Web Push (VAPID;
`PushSubscription`, `PushAllows`, envío desde `Notify` y desde el timbre,
service worker, manifiesto instalable, botón «Avisos en este dispositivo»,
`pushQuiet`/`pushCi`). Ver `docs/notifications.md` §3 ter. **W2 publicado**
(`3c1acc7`, `d9adfe1`).
**W3 hecho, sin commitear (8-oct, tarea cac #142): invitados a llamadas y
llamadas desde la web.** Plan en `~/.claude/plans/shimmering-crunching-kitten.md`.

- **Cómo funciona.** Cada invitación es una sala propia, `meet:<id>`, y nunca
  la de un canal. El invitado es `guest:<id>`, una identidad que acuña el
  servidor. Puede publicar micrófono, cámara y pantalla, pero no datos, y no
  puede renombrarse. Hay dos tokens HMAC: el enlace y el pase.
- **Backend.**
  - Rutas `/api/v1/call-invites` para los miembros.
  - Una puerta pública de dos rutas, `/api/v1/public/calls/{inspect,join}`.
  - Echar a alguien usa `RemoveParticipant`.
  - El índice de grabación pasó a ser por sala (`EnsureRecordingIndexes`).
  - Una reunión cuenta sus miembros, no sus personas, para saber si está vacía.
  - El token de voz se firma con el nombre visible.
- **App.**
  - Interfaz `lib/voice-engine` con dos motores: Tauri y `livekit-client`, que
    sólo se usa en el build web.
  - La voz ya no está apagada en la web.
  - Páginas `/call/:id` (miembro) y `/join#token` (invitado, sin sesión, con el
    aviso de grabación antes de entrar).
  - Diálogo «Llamar con invitados» en la cabecera del canal.
  - La CSP web permite `rtc.guz-studio.dev`.
- **Mutación.** 47 mutantes en el backend y 31 en la app, todos muertos.
- **Falta.**
  - Probar de punta a punta con un navegador real (miembro en el escritorio y
    un invitado en incógnito).
  - Commit y release: primero el backend, después la web y la app.
- **TURN (8-oct).** El relé va por el 443 para las redes que sólo dejan salir
  ese puerto (`docs/voz.md` §6 bis). Está escrito y probado en el repo, pero
  **no está aplicado**. Falta, en este orden:
  1. El DNS de `turn.guz-studio.dev` (lo pone jose).
  2. `infra/k8s/turn-setup.sh` en el VPS.
  3. Desplegar el backend.
**Barrido de seguridad (6-oct), tanda 2 hecha, sin commitear.** Regla: crear
una org sigue abierto a cualquiera, así que nada peligroso depende sólo de ser
admin de una org. Servidores kubernetes y vistas del clúster: sólo superadmin;
cambiar host/usuario/puertos de un servidor y registrar o reconfigurar un
servicio desplegable: admin; pase al agente: miembro (no viewer); llave y
webhook de un canal: admin. Sesión web marcada en el token (`client: "web"`):
no llega a `/servers` ni a `/auth/tokens`. Proxy de integraciones en su propio
dominio (`tools.guz-studio.dev`; en el de cac contesta 404). Adjuntos con
`nosniff` y HTML/SVG como descarga. Cambiar la contraseña cierra todas las
sesiones. Push: sólo servicios reales, tope de 10, nunca cambia de dueño. El
backend no arranca en el clúster sin sus secretos. La web: CSP y cabeceras,
sin trozos de escritorio, y salir olvida el navegador. **Publicada**
(`f662bd4`, `10c7456`, `394cfa4`). **Agente v5, hecho:** el pase lleva el rol
dentro del sujeto firmado (`usuario|w` / `usuario|r`, el v4 lo sigue
aceptando); el agente no deja reiniciar a un pase de lectura; un viewer sólo
recibe pase si el agente del servidor ya es v5; la app esconde reiniciar y
desplegar al viewer e instala `:v5`. Orden: backend → imagen del agente → app.
**Publicado en la v1.6.88.** **Tanda 3 (6-oct), hecha, sin commitear:** por la URL
sólo viaja un pase corto con alcance (`media`/`events`, 30 min, otra llave), nunca
el token de acceso; HSTS en backend y web; meter a alguien en una org sin que
acepte sólo si ya es de tu gente (si no, `invite-required` y la app lo invita);
fuera de tus orgs sólo encuentras a alguien por su usuario exacto; cambiar la
contraseña cuelga los streams abiertos (`session:revoked`); el login cuenta
también por IP (la última de `X-Forwarded-For`) y barre lo viejo. Queda para
después: tokens en `localStorage` → cookies `httpOnly`. **Tanda 3 publicada**
(`e0590f7`, `1726efe`, `e2e7054`). **v1.6.89 (6-oct):** CSP en el escritorio
(probada a mano, tarea en App), el visor de PDF por fin abre (CORS en `cacmedia`,
y no choca con React), los PDF como tarjeta con su primera página en todos los
sitios, adjuntos en directos (sólo los dos de la conversación). **Pendiente:**
en canales la guarda de adjuntos sólo mira la org (un canal privado no la
estrecha); quitar la compatibilidad transitoria de grabaciones
(`legacyDesktopRecordingViewer`) cuando la v1.6.89 lleve tiempo.

**Módulo de servidores completo (3-oct):** R0–R8 publicadas (#106 en Done).
v1.6.83: un playbook que falla en el acto ya no se queda «aplicando» (#116).
v1.6.84: la pantalla compartida desde Mac ya no sale inclinada (#98: se
ignoraba el stride de cada fila); falta verlo en un Mac de verdad.
Y con dos monitores, compartir pregunta cuál (#117); antes era siempre el
primero que listaba el sistema. En Wayland sigue preguntando el portal.

**Publicado (v1.6.75):** #96 (crear usuario pide nombre y correo; ojo en toda
contraseña) y #97 (auditoría de estados al recargar y al cambiar de org). Para
después: #98, arreglado en la v1.6.84.

La app va por la **v1.6.78** (30-sep; los instaladores compilándose al
escribir esto).

**La v1.6.71 (27-sep) lleva:**

- **#80 — un vencimiento cae en el día elegido en cualquier zona.** jose (UTC−6)
  soltó una tarea en el 30 y se pintó en el 29: lo guardado estaba bien y
  `ItemCalendar` lo leía con captadores locales. `CalendarItem` distingue ahora
  `day` de `at` por tipo. Verificado a mano el 26-sep con la build local.
- **#69 — el CI corre las pruebas de la app**, bajo las tres zonas, y frena la
  release si fallan. Para poder encenderlo hubo que tapar el error huérfano de
  tiptap que hacía salir la suite con código 1 con todo en verde.
- **#70 — cambiar la bandeja desde Integraciones** (backend). Decía «esa lista es
  de otra organización» con cualquier lista: la guarda preguntaba por
  `task_lists.deleted_at`, que no existe, e ignoraba el error. Y detrás,
  `Update` no guardaba `list_id`. Pruebas contra Postgres.
- **#81 — el detalle de una tarea por debajo de 1024 px** aplastaba la
  descripción a una letra de ancho.

## 📄 Documentación por proyecto

El handoff de `.design-project-docs/` entero salvo el PR 7. Un documento por nodo
con cuatro pestañas fijas (resumen, runbook, decisiones, enlaces), responsable y
frescura a 90 días, autoguardado con historial, plantillas, decisiones con
procedencia, compartir al chat y volver desde él, e índice de la organización.

| Abierto | Por qué |
|---|---|
| PR 7 — GitHub | **No se empieza** hasta que existan la App de organización y el receptor de webhook. Es infraestructura, no código de app. |
| `DocView.tsx` sigue en el repo | Se borra cuando las pestañas estén verificadas a mano contra el backend desplegado. |
| `/doc` en el compositor | El menú `/` está escrito contra el DOM, no contra React: meter ahí un selector de documento es un PR propio, no una línea. |

El MCP ya escribe documentación: seis herramientas con dos permisos separados
(`docs:write` sólo añade, `docs:manage` puede pisar), y guardar a la vez ya no
borra lo del otro.

## 🎙️ Grabar la reunión (antes: transcribirla)

Plan: `~/.claude/plans/precious-sleeping-sonnet.md`.

**El rumbo cambió el 16-sep-2026.** La transcripción en CPU no salía a cuenta
(`large-v3-turbo` por debajo de 0,45× en el nodo) y jose la aparcó: *«me basta
con lograr grabar la reunión»*. Grabar vale por sí solo y deja la puerta
abierta — las pistas `.ogg` por persona que guarda son exactamente la entrada
que la transcripción pedía, así que ese camino pasa a costar cero.

Se graba **voz y pantalla compartida. Las cámaras no**, por decisión de
producto. Con **Track Egress**: cada pista se escribe tal como llega, sin
decodificar (~0,1 núcleo), y al colgar un servicio mezcla el audio y lo pega a
la pantalla. Componer en vivo habría costado ~3 núcleos durante toda la llamada
para montar caras que nadie va a mirar.

| Fase | Qué | Estado |
|---|---|---|
| 0 | Grabar por pistas y montar **a mano**, antes de escribir backend | **pasada** — ver abajo |
| 1 | Backend: dominio `Recording`, cliente Twirp, reloj, rutas | **hecha y probada contra el SFU** |
| 2 | Mux (`recordings-mux`) + proxy con `Range` | **escrita y probada de punta a punta** |
| 3 | App: consentimiento, chip REC, panel de grabaciones | **hecha**, sin verificar a mano en la app |
| 4 | Endurecer, y el puente a la transcripción | no empezada |
| 5 | La grabación en el canal, las pestañas y buscar dentro | **escrita**, sin verificar a mano |

### La grabación en el canal, y las pestañas (21-sep-2026)

Grabar funcionaba de punta a punta y **no avisaba a nadie**: una grabación sólo
existía si alguien abría el panel a buscarla. Y el panel era una alternancia con
el hilo, un apaño que lo decía en su propio comentario.

| # | Qué | Dónde |
|---|---|---|
| 0 | Pestañas —Conversación / Multimedia / Grabaciones / Enlaces— en vez de la alternancia | `ChannelView.tsx` |
| 1 | `ChatMessage.Kind` (`user\|system`), `PostSystem`, y las guardas de `Edit`/`Withdraw` | `domain/chat.go`, `service/chat.go` |
| 2 | `MuxReady` lo cuenta en el canal, **detrás** de `Transition` | `service/recording.go` |
| 3 | La app ramifica por `kind`: sin firma, sin desplegable | `ChannelView.tsx` |
| 4-5 | Multimedia y Enlaces, sacados de los cuerpos al leer | `domain/refs.go`, `repository/chat.go` |

Lo que decidió el diseño, y no cabía en un comentario suelto:

- **`kind` del mensaje, no del autor.** El veto de `domain/chat.go` es al autor
  discriminado (`user|reporter|tenant`), que sugeriría que un cliente puede
  escribir aquí. `ItemComment.Kind` es el precedente exacto.
- **`AuthorUserID` sigue siendo quien grabó.** No por el `not null`: porque una
  app vieja ignora `kind` y pinta la línea firmada por esa persona, y así se lee
  bien. Eso es lo que la hace desplegable antes que la app.
- Y de ahí sale la guarda: con ese autor, `mine` es cierto para quien grabó, así
  que **vería Editar y Retirar sobre el mensaje del sistema**. Se rechaza antes
  de mirar la autoría, y el superadmin tampoco pasa — esto es un registro.
- **Multimedia y Enlaces no tienen tabla.** Se leen de los cuerpos: un borrador
  abandonado es invisible por construcción, y retirar un mensaje retira sus
  imágenes. El `LIKE` de la consulta sólo descarta barato; lo que define un
  enlace es la regex, **en el servidor** — extraer en el cliente rompería la
  paginación, la deduplicación y el rótulo de `[texto](url)`.

**46 mutantes muertos**, por planes de `/mutar`:

| Dónde | Nº | Los que más dicen |
|---|---|---|
| `domain` | 9 | el paréntesis del enlace, el uuid abierto a `.+`, la deduplicación, el anuncio en primera persona |
| `service` + `repository` | 14 | `m.kind` fuera del `Select` literal, las dos guardas **y su orden**, el prefijo de autor, el `deleted_at`, el `space_id`, el cursor |
| la búsqueda (servidor) | 7 | buscar saliéndose del canal, el acierto del enlace confundido con el del mensaje, multimedia estrechando por el cuerpo |
| `card-menu` | 3 | el prefijo laxo, el uuid abierto |
| `ChannelView` | 6 | el desplegable gobernado sólo por `mine` |
| `Markdown` | 2 | quitar el `urlTransform`, o abrirlo a cualquier protocolo |
| la búsqueda (app) | 5 | filtrar en el cliente en vez de mandar `q` |

Y de paso, un fallo que llevaba ahí desde las menciones: **react-markdown vaciaba
el `href` de todo lo que empezara por `cac:`**, así que `onInternalLink` nunca
veía una mención y el clic se caía a la rama de los adjuntos. Guardián en
`enlaces.test.tsx`.

**Paso 6, buscar dentro del canal**: hecho, y en el servidor. Una caja en la
fila de pestañas que modifica la activa, con `?q=` sobre el hilo, multimedia y
enlaces. `LOWER(…) LIKE`, que es la decisión ya tomada en `note.go:250`; nada
de esto la revisa. Dos matices que tienen guardián: el acierto de un enlace lo
decide **el enlace**, no el mensaje que lo contiene (el `LIKE` del cuerpo es
sólo descarte barato, y casa de más), y multimedia se busca por el **nombre del
fichero**, que no está en el texto — estrechar ahí la ventana por el cuerpo
perdería aciertos en silencio. La consulta se vacía al cambiar de pestaña:
«factura» quiere decir otra cosa en Multimedia que en la conversación.

Buscar **globalmente** sigue fuera: eso es la paleta, es org-wide y sin ancla,
y contesta otra pregunta.

Lo que ya está desplegado y no se toca: SFU y Egress con la versión pineada por
digest, bus Valkey propio con su `CiliumNetworkPolicy`, y un usuario IAM que
**sólo escribe bajo `recordings/*`**. Todo con fecha en `docs/grabacion.md`.

De la transcripción sobrevive lo puro y probado —`merge.py` y el filtro de
`stt.py`, 20 mutantes muertos— esperando a la fase 4. Y la medida que la aparcó
está anotada en `docs/transcripcion.md`.

### Lo que la fase 1 dejó escrito (17-sep-2026)

Backend entero menos el mux y el proxy de media, que son la fase 2. Apagado por
defecto: `RECORDINGS_ENABLED=false` en `2-deployment.yaml`, y con eso el reloj
**ni siquiera arranca**.

| Pieza | Dónde |
|---|---|
| Dominio y estados | `domain/recording.go` — una sola máquina, dicho a propósito |
| Repositorio y el índice parcial | `repository/recording.go`, `db.go` |
| Cliente del SFU | `adapters/livekit/client.go` — clientes Twirp **generados** |
| Servicio y reloj | `service/recording.go`, `adapters/http/recording.go` |
| Rutas | `policy`, `list`, `start`, `get`, `stop` |

Tres decisiones que cuestan explicarse y se quedaron escritas al lado del
código: el tick es de **10 s** (en 30 cabe un «hola, ¿me oyes?» entero, y una
sala vacía tardaría un minuto en cortarse); una **pista muteada se graba igual**
(saltarla obligaría a detectar el unmute y perder los primeros segundos de quien
vuelve a hablar); y el 503 de «no está encendido» sólo sale en lo que escribe —
una instalación a la que se le apagó la grabación sigue enseñando lo que ya
grabó.

**37 mutantes muertos** repartidos en dominio (9), cliente del SFU (5), servicio
(21) y las etiquetas JSON (2). Los que más importan: quitar el filtro de cámaras,
ignorar quién ganó el `ClaimTrack` —un egress por tick sobre la misma pista—,
tratar `ENDING` como terminal, guardar la clave que se pidió en vez de la que
Egress escribió, y `json:"-"` convertido en `json:"objectKey"`.

Y el grabador dejó de salir en «quién está en el canal»: entra a la sala como un
participante más, y sin filtrarlo una llamada donde sólo queda él parecería
ocupada. Con respuesta real del SFU capturada, como el resto de ese fichero.

**Probada contra el SFU y el S3 de verdad**, y sin necesitar a nadie dentro de
la llamada: la claqueta de la fase 0 aprendió a publicar también una pista de
**cámara** (`tools/clapper.py --camera`), así que hace de participante completo
y el filtro se comprueba en vivo en vez de contra un doble. El guion está en
`TestLiveSFURecordsWhatIsInTheRoom`, que se salta solo salvo que se le dé
`RECORDINGS_LIVE_ROOM` — así no molesta al CI y queda para repetirlo cuando
LiveKit suba de versión.

Lo que contestó el SFU de verdad: micro y pantalla **se graban**, cámara **se
descarta**, los dos ficheros salen `complete` con la clave que Egress escribió
(`.ogg` y `.webm`), y la grabación cierra con su `FirstMediaAt` y su
`EgressDoneAt`. Veinticinco segundos de punta a punta.

**Y encontró un fallo que ningún doble podía encontrar.** `keySegment` se
aplicaba también al prefijo, así que `RECORDINGS_PREFIX=recordings/gate` se
convertía en `recordings-gate`: no es que no funcionara, es que escribía **fuera
del rincón** que la credencial de Egress tiene permitido, y cada pista moría con
un `AccessDenied` que sólo se ve minutos después de colgar. Arreglado con
`keyPrefix`, que conserva las barras del prefijo y sigue quitándoselas a lo que
viene de fuera.
→ Guardián: `domain.TestANestedPrefixKeepsItsSlashes`.

**Y la última puerta —matar el pod de Egress a mitad— también pasa, pero
obligó a rediseñar el cierre.** El primer intento dejó las pistas en `active`
157 segundos sin que nada se enterara: una grabación así no cierra nunca y el
mux no la ve. De las cuatro señales que LiveKit ofrece para distinguir un egress
vivo de uno muerto, **tres no valen** y se midieron una a una — el estado se
queda en `ACTIVE` para siempre, `updated_at` no late ni estando sano, y el
participante del egress no se va de la sala al morir el pod. La única que sirve
es `StopEgress`, que contesta 408 en 3,4 s cuando nadie lo posee.

Pero preguntar **es** parar, así que sólo se pregunta al cerrar. El reparto
honesto: mientras se graba, un pod que muere **no se detecta** (lo escrito antes
está en S3, lo de después se pierde); al parar, se detecta en **25 s** y la
grabación cierra en vez de colgarse.

Y no vale contar cualquier error: «ya terminó» es un 412 y es buena noticia.
Confundirlo con el 408 tiraría la grabación que salió bien.
→ Todo con sus números en `docs/grabacion.md`, y cinco guardianes nuevos.

Detalle que costó un intento: `kubectl delete pod` **no** reproduce el fallo —es
una baja ordenada y Egress termina sus ficheros bien—; hace falta `--force
--grace-period=0`.

### Y la fase 2: el montador (18-sep-2026)

La cadena entera contra el SFU y el S3 de verdad —grabar, cerrar, montar,
`ready`, servir un trozo— con el montador **de verdad**, su ffmpeg y su boto3:

| | |
|---|---|
| Con pantalla | 26 s montados en **1,2 s** · `final.mp4` |
| Sólo voz | 24,8 s montados en **0,3 s** · `final.m4a` |
| El rango | `bytes 0-99/87679` → 206, o sea que se puede buscar en el vídeo |

Dos cosas que sólo aparecieron al ejecutar, no al leer:

**El lienzo del vídeo no terminaba nunca.** `color=` es una fuente infinita y
`eof_action=pass` le quita la otra forma de acabar: quince minutos de CPU y
cincuenta megas para tres minutos de grabación. Arreglado con un `d=` calculado
y `-shortest` de cinturón.

**La política de red del plan habría tirado la API.** En Cilium, una regla de
entrada sobre `cac-service` lo vuelve denegar-por-defecto, incluido el tráfico
del Gateway. Está escrita al revés: salida sobre el montador, que sólo puede
hablar con el DNS, con el 8081 y con S3.

Y el montador tiene **su propio usuario de IAM**, sin `DeleteObject`: ante un
fallo no puede llevarse por delante las pistas originales.

**Encendido en producción el 20-sep-2026.** Usuario de IAM creado, los tres
secretos puestos, `RECORDINGS_ENABLED=true` desplegado y el montador arriba
—«mux up, polling …:8081 every 15s», sin un solo aviso, que es como se ve que la
llave casa en los dos lados—.

Y la frontera del puerto interno, comprobada desde fuera: `/internal/…` contesta
el `404 page not found` del enrutador **público**, igual que cualquier ruta
inventada. La única `HTTPRoute` que llega a `cac-service` nombra el puerto 80
explícitamente. El Gateway **sí sabe llevar TCP crudo** —ya lo hace con Postgres
en el 5432—, así que lo que protege el 8081 no es que no pueda, es que **hoy no
hay ninguna ruta que lo nombre**; detrás están la llave y la política de salida
del montador.

Falta **mirarlo en la app con una llamada de verdad**. Todo tiene prueba, pero
«el botón está donde se espera y se entiende» no lo dice ninguna.

### Un guardián que llevaba meses ciego (18-sep-2026)

Al pasar la puerta de la fase 2 saltó `api-errors.test.ts`, que exige que cada
código de error del backend tenga frase en los dos catálogos. Sólo cazó **dos**
de los siete códigos nuevos, y mirando por qué salió lo otro: el guardián
buscaba con `grep` **línea a línea**, y una llamada a `SendErrorResponse` ocupa
dos o tres líneas casi siempre. Veía una minoría.

Arreglado —lee cada fichero entero— aparecieron **treinta y un códigos sin
traducir, veinticuatro de ellos anteriores a esta rama**: `bad-transition`,
`ring-outsider`, `subtasks-open`, `superadmin-only`, `general-space-protected`…
Todos salían en inglés aunque la app estuviera en castellano, y nadie lo había
reportado porque el toast dice algo razonable, sólo que en el idioma que no es.

Los treinta y uno traducidos en los dos catálogos, menos los dos del puerto
interno: ésos sólo los lee el montador, y pedirles una frase sería traducir algo
que no ve ninguna persona.

Y de paso cayó una prueba que **daba el fallo por bueno**: `voice.test.ts`
comprobaba que al rechazar una llamada saliera `ring-outsider` **crudo** — lo
cual pasaba justamente porque no tenía traducción. Ahora comprueba que sale la
frase.
→ Tres mutantes muertos sobre el guardián arreglado, incluido «vuelve a mirar
línea a línea».

### La fase 3, en curso (18-sep-2026)

El lado de la app. Lo que ya está y está probado:

| Pieza | Qué |
|---|---|
| `voice.rs` | `VoiceEvent::Recording` + `recording_from_metadata` — puro, 6 pruebas, 3 mutantes |
| `voice.store.ts` | `grabacion` en `VACIO`, para que salir de la llamada apague el chip |
| `recordings.store.ts` | política, empezar, parar, lista, borrar, `alCambiarEstado` — 13 pruebas, 8 mutantes |
| `RecChip` | «REC · Ana», `role="status"`, parpadeo con `motion-safe` |
| `RecordingConsentDialog` | siempre pregunta, y **dice que las cámaras no se graban** |
| `RecordingsPanel` | `<audio>` si es sólo voz, `<video>` si hay pantalla, `src` por el proxy |
| catálogos `recordings.json` | en los dos idiomas, con espacio de nombres registrado |

**El botón no enciende el chip.** Lo enciende el motor cuando el SFU dice que el
metadata de la sala cambió, así que aparece en todas las pantallas a la vez —y
en la de quien entra tarde. Pintarlo al pulsar parece más ágil y miente: si el
servidor rechaza, la pantalla de quien pulsó diría que se está grabando y las
demás dirían que no.

Dos cosas que salieron por el camino:

**`NAMESPACES` vive en tres sitios y yo toqué dos.** El propio comentario de
`i18n.ts` lo avisa; faltaba `i18next.d.ts`, y el compilador lo cazó. De ahí salió
un guardián nuevo, `catalogos.test.ts`: paridad de claves entre los dos idiomas,
ninguna frase en blanco, y que **ningún fichero de catálogo se quede fuera de la
lista** — tres mutantes muertos.

**Una prueba montaba la tienda a medias** y `gente` llegaba sin definir, así que
mi `gente.find` reventaba la barra entera. Arreglado con `?? []`, que además
cubre el caso real: quien graba puede haberse ido de la llamada.

Montado lo que faltaba:

**El panel va dentro del canal, no en otro carril.** `ChannelView` ya *es* el
carril derecho —lo dice la cabecera del fichero—, y abrir otro al lado pedía un
rail de dos columnas, que es un cambio de maqueta mayor que la función. Así que
alternan: o se lee la conversación, o se ven las grabaciones. El botón sólo se
pinta si el servidor graba.

**El aviso al que entra tarde** (`RecordingBanner`) es una franja, no un modal:
el acuerdo es «aviso + quedarse», no «acepta para poder hablar», y un modal en
mitad de una reunión interrumpe a la persona equivocada. Ofrece irse, y colgar
de verdad. Se enseña **una vez por grabación, por id**: parar y volver a empezar
es otra y vuelve a avisar — con un booleano, la segunda pasaría en silencio.

**El toast es para quien minimizó la llamada**, que es el único que no ve ni la
franja ni el chip. Se calla con el escenario abierto: el mismo hecho anunciado
dos veces se lee como dos grabaciones.

Un mutante se quedó vivo y tenía razón: la prueba del toast comprobaba que
avisara, no **qué decía** sin nombre — e interpolar un hueco vacío deja una
frase que empieza en blanco. Hay una frase distinta para ese caso y ahora se
comprueba.

**Lo que no se ha hecho: mirarlo en la app.** Todo lo de arriba tiene prueba,
pero «el botón está donde se espera y se entiende» no se prueba con vitest.

## 📮 Reports — cac as the single home for bug reports

Consolidating three independent report modules (portento's `bug-tickets`, cac's
own, and trans-ops' "Fallas y Mejoras") into cac, with each app as a tenant.
Plan: `~/.claude/plans/compressed-cooking-pond.md`.

**cac's side (Parte A) is done and deployed** as of 1-ago-2026:

| | What shipped |
|---|---|
| Status vocabulary | `open / in_progress / done / closed`. The old `pending`/`resolved` are **permanently accepted** on input — the console is an installed binary, so server and clients can't change at once |
| Taxonomy | `category`, `priority`, `area`; valid sets served by `GET /api/v1/reports/taxonomy` so no client keeps a copy |
| `reporterId` filter | Lets a tenant build "my reports" without cac indexing per user |
| Outbound webhook | Per project, HMAC-signed (`X-Cac-Signature`), all five report events |
| Provisioning | In the console (*Reports → Projects*): integration type, rate limit and webhook |

**Open items:**

| Item | Owner |
|---|---|
| Merge `a1-step3-rename` — renames what's *stored* to `open`/`done`. Gated on **v1.5.1 being installed everywhere**: an older console would show an empty board | jose confirms, then cac session |
| Create the portento tenant in the console → yields the credentials the portento repo needs | jose |

## ✅ El CI ya corre las pruebas del backend

Tarjeta #38, cerrada. `backend.yml` lleva un trabajo `test` con Postgres 16 por
delante de `build-push`, así que **rojo no despliega**. Antes este workflow
empujaba a producción solo, sin que nadie mirase.

Al encenderlo salió lo que la tarjeta avisaba que saldría:
`TestSearchNeverReturnsSomebodyElsesDirectMessages` llevaba roja desde el día que
aterrizaron los documentos. El test se construye su propio esquema a mano y esa
lista es **la huella de la consulta de búsqueda**, no de los datos que escribe:
le faltaban `docs`, `doc_tabs` y `task_folders`, que la búsqueda une. Nadie podía
verlo porque sin base la prueba se salta.

Lo que sigue sin red: `app/` y `transcriber/` no corren sus suites en ningún
sitio. Es un workflow corto y aparte, no una línea más en éste.

## 🔢 El orden de un tablero ya no depende de cómo se instaló Postgres

`rank` pasó de `varchar` en base 62 a `NUMERIC`. Salió tirando del hilo de la
tarjeta #38: el CI nuevo, con Postgres de Debian/glibc, hacía fallar la
ordenación de carpetas, y debajo estaba esto — `core/rank` reparte claves sobre
`0-9A-Za-z` y da por hecho el orden de bytes, pero quien las ordena es Postgres
con `ORDER BY rank`, y ahí manda la colación. Con una de locale, **el segundo
elemento de cualquier contenedor se pinta antes que el primero** (los primeros
rangos eran «U» y «k»).

**Producción no estaba rota**: comprobado en `dwit_kb`, todas las bases están en
`C` y ordenaban bien. Pero por suerte, no por diseño — nada en el esquema lo
pedía. A un número no hay colación que aplicarle.

| Qué | Dónde |
|---|---|
| Alfabeto `0-9`, una clave es el número que escribe | `core/rank` — el algoritmo no cambió, era agnóstico del alfabeto |
| Migración de datos, antes de `AutoMigrate` | `repository/rank_migration.go` — conserva el orden que la gente ve hoy |
| La columna, con `default:0.5` | Una fila sin rango tiene sitio en vez de reventar la inserción |
| Un reporte ya no nace sin rango | `CreateWithSeq` — antes se guardaban con `''`, **todos empatados**, y el orden entre ellos lo decidía Postgres de una consulta a otra |

La suite entera pasa con las dos colaciones, que es la prueba de que la
dependencia se fue. 16 mutantes muertos entre el paquete (8), la migración (6) y
el guardián de tipo (2); dos salieron vivos y se investigaron.

La app no se toca: nunca calcula un rango. Arrastrar manda ids de vecinos
(`afterId`/`beforeId`) y el rango lo deriva el servidor.

## 🧹 El widget, retirado — y con él la credencial pública

Ya no se hacen apps con widget: todo entra server-to-server. Borrado `widget/`
(11 ficheros, ~1.774 líneas) y, lo que importaba de verdad, **el modelo de
credencial que arrastraba**.

Había dos clases de proyecto. La `web` entregaba su llave dentro del navegador
—pública por diseño— y sólo la guardaba una lista de orígenes que la
comprobación **se saltaba entera** para cualquier petición sin cabecera
`Origin`, o sea para cualquier `curl`. Por eso una llave así no podía leer ni
clasificar. Y la columna tenía `default:'web'`: un proyecto creado sin decir
nada nacía con la credencial débil.

Ahora hay una sola clase, y ninguna llave anda suelta por un navegador.
→ Guardián: `middleware.TestNoSecondClassOfProjectKeyComesBack`.

Comprobado en producción antes de tocar nada: los 3 proyectos vivos son `app`
con la lista de orígenes vacía, y para ellos la comprobación ya devolvía `true`
sin mirar nada. **El borrado no cambia comportamiento de nadie.**

| Se fue | Se queda |
|---|---|
| `platform`, `allowed_origins` (columnas borradas con migración propia) | `projectKeyMayReach` — acota la llave a rutas de reportes, no era del widget |
| La lista de orígenes, su CORS por proyecto y sus dos errores | El CORS reflejado y el `?token=`: los usa la vista del reportero |
| `OriginsEditor`, el aviso de «llave pública», 6 claves de idioma | |

**La frontera que no se cruzó, y por qué.** Las rutas para que el reportero vea
su propio reporte parecían del widget. No lo son: **170 comentarios han entrado
por ahí** — portento 113, salud-en-casa 38, boaty 7 — y los tres son
server-to-server. Pintan su propia pantalla con el `token` que la ingesta les
devuelve. Quitarlas habría roto tres integraciones vivas.

| Abierto | |
|---|---|
| `tds-geolocation` | El único proyecto `web`, app abandonada, 0 reportes. Al irse la distinción su llave pasaría a poder leer. Dejarla inerte con `is_active = false` es reversible y de una línea. |
| npm | `@g-studio/report-widget` sigue publicado, sin tocar, por si se refina más adelante. |

## 🎙️ La fase 0 de grabación, pasada (17-sep-2026)

**La puerta que podía tumbar el diseño era la alineación, y no la tumba.** Todo
en `docs/grabacion.md`; lo corto:

**Se monta, y sale barato.** Tres pistas a la vez (dos micros y una pantalla),
las tres `EGRESS_COMPLETE`. Montar 3 minutos costó **4,9 s** —36× tiempo real—
y salieron 6,67 MB: **~130 MB/hora**, contra ~3,6 GB/hora de componer en vivo.
El texto pequeño de la pantalla se lee a 10 fps y CRF 18.

**El DTX no rompe la línea de tiempo.** Era el riesgo que más pintaba. El `.ogg`
del micro enseña el valle de 17 dB donde la persona se calló, y sigue midiendo
180,03 s contra 180,3 s de pared: el hueco se conserva donde estaba.

**`started_at` es un ancla de verdad**, y eso hubo que medirlo dos veces. Con
una persona diciendo «tres» frente a un cronómetro **no se puede**: su tiempo de
reacción es del tamaño de la medida. Así que la fuente pasó a ser una máquina —
`tools/clapper.py` publica micro y pantalla movidos por el mismo reloj, un
pitido y un destello **a la vez**— y `egress_tracks.py --stagger` arranca los
dos egress con segundos de diferencia a propósito:

| Toma | `started_at` micro − pantalla | Desfase medido tras alinear |
|---|---|---|
| `clap2` | +60 ms | +75 ms |
| `clap3` | **−5 777 ms** | **+64 ms** |

Los egress arrancaron con 5,8 segundos de diferencia y los golpes siguieron
coincidiendo dentro de 73 ms. La puerta pedía ≤ 300 ms. Y los ~74 ms que quedan
no son del grabador: contra el horario que la claqueta imprime, el vídeo llega
con 0–5 ms y el audio con +74 ms constantes — la cola del emisor, no la
grabación.

Lo que queda por medir no puede tumbar nada: coste del mux con la máquina
cargada, techo de Egress con seis personas, y Valkey caído a mitad. Mueven un
límite de un `Deployment` o un número de un `values`.

**De la transcripción**: el bot participante recibe media desde un pod sin
tocar `rtc.tcp_port` (119,52 s de 120, medido el 12-sep-2026), y el `rtf` del
modelo se quedó sin medir porque el rumbo cambió antes. El guardián que impide
que `mint` acabe pudiendo publicar sigue en pie:
`test_el_grabador_no_puede_publicar_le_pases_lo_que_le_pases`.

## ⏳ Planned (next iterations)

### App UI for container stats

Backend endpoint exists (above). Now consume it from `app/src/pages/ServerManage.tsx`:

- Per-service stats table: CPU%, RAM (used / limit), Net Rx/Tx, Block R/W per task.
- Poll `/api/v1/services/{id}/stats` every ~5s while the panel is open. Stop polling on navigation away.
- Show a per-row error badge when the agent returned `error` for that task (means Docker stats call failed but task exists).
- Pre-requisite: the new `swarm-manage` image (built from the in-progress endpoint) must be rolled out to each server via the "Update Agent" button.

## 💭 Future / nice-to-have

- **Quitar las llaves estáticas de AWS del clúster (IRSA).** Los tres usuarios
  de IAM —image-service, Egress y el montador— usan pares de llaves de larga
  duración metidos en Secrets de Kubernetes: sin caducidad, sin rotación
  automática, y rotarlas a mano obliga a reiniciar el pod que las use. Las de
  `recordings` se rotaron una sola vez, y fue por una filtración.
  Lo que lo arregla es que cada ServiceAccount asuma un rol por OIDC. **No sale
  gratis aquí**: el clúster es autogestionado (Contabo, no EKS), así que hay que
  publicar el documento de descubrimiento OIDC del clúster en un endpoint
  público y registrarlo como proveedor OIDC en IAM. Es un trabajo propio con su
  propio riesgo; separar usuarios por workload —que es lo que se ha hecho— no lo
  arregla, sólo evita empeorarlo y deja el rastro de CloudTrail utilizable.


- **File upstream bug at `tauri-apps/tauri-action`.** The inconsistent sanitization in `upload-version-json.ts` (uses `[ ()[\]{}]` → `.`) vs. `ghAssetName` (uses `[^a-zA-Z0-9_-]` → `.`) means any `productName` with chars like `&`, `+`, `@`, etc. breaks `latest.json` upload silently. Worth a PR to align the sanitizers.
- **Existing C&C installs won't auto-migrate** to the new `CAC` install path. On a new release tag, users will end up with two installs side by side (old `C&C` and new `CAC`). Document the manual cleanup step when we cut the release.
- **Scrub rotated DB password from git history** (`git filter-repo` + force push). Credentials in `78d0129` and `769e592` are already rotated and inert; only do this for hygiene if it matters. Destructive — rewrites public SHAs.
- **Audit other places that may rely on go-keyring on the backend.** Removed for SSH keys; none known to remain.
- **Per-server PATs.** Today the GitHub PAT is shared globally (`PATK_global_usage`). When multi-server / multi-org becomes a thing, the 1Password reference should be stored per `server_id` rather than once globally. The keychain layer already supports that (the `ref_account(server_id)` function in `lib.rs`); only the UI assumes a single global key.

## ✅ Done (this thread)

| Commit | What | Why |
|---|---|---|
| `8f0fad1` | `createUpdaterArtifacts: true` in Tauri config + trailing slash on collections list/create calls | Updater was 404-ing because no `latest.json`/`.sig` artifacts were being produced; collections list/create were 404-ing because chi registers `r.Get("/", ...)` with trailing slash. |
| `7133059` | Untrack `backend/.env` and `backend/tmp/`; add `backend/.gitignore` covering `.env` + `tmp/` | Stop accidental commits of secrets and Air's build artifact. Existing credentials in history were already rotated. |
| `54d5840` | `workflow_dispatch` on the backend workflow | Enables manual re-deploys without dummy commits to `backend/**`. |
| `94c450c` | Per-folder READMEs (root, app, backend, swarm-manage), `STATUS.md`, groups proposal under `docs/proposals/` | Replace default Tauri stub README; document architecture and CI/CD; sketch multi-user evolution. |
| `a667a4a` | Remove backend SSH key storage + `deploy-agent`/`update-agent` endpoints; drop `zalando/go-keyring` and `golang.org/x/crypto/ssh` | Keyring path was dead on a Linux k8s pod; SSH-from-app will replace it. |
| `36c870e` | Drop frontend deploy/update-agent UI (hook fns, dialog field, dashboard buttons) | Backend endpoints gone — UI followed. |
| `47dcae7` | Tauri commands `load_github_token_from_1password` / `refresh_*` / `get_op_reference` / `clear_op_reference`; UI in Stack Secrets for "Load from 1Password" + "Refresh" using `op read`. Reference stored in OS keychain as `op-reference:<server_id>`. | Streamline PAT entry — user no longer copy-pastes from 1Password. |
| (manual) | Rotated GitHub secret `DATABASE_URL` + redeployed backend via `workflow_dispatch` | `/health` returns 200 again. |
