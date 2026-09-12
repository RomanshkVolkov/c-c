# STATUS

Tracking doc — open items, in-progress work, and decisions from rolling conversations. Update this file when you start/finish work or change direction.

## 🚨 User action required

| Item | Context | Owner |
|---|---|---|
| Verificar la v1.6.68 instalada | Lleva el medidor de micrófono, el selector de fecha propio, el check de subtareas, los avisos de membresía y el adjunto citado. Nada de eso está comprobado a mano. | jose |
| Merge `a1-step3-rename` | La rama sigue viva. Renombra lo *almacenado* a `open`/`done`; una app vieja mostraría un tablero vacío. | jose confirma |
| Rodar la imagen nueva de `swarm-manage` | El endpoint de stats por tarea ya está; hace falta el botón «Update Agent» por servidor para que la app pueda consumirlo. | jose |

## 🟢 Al día

Nada sin empujar. La app va por la **v1.6.69** («que los avisos avisen») y el
backend está desplegado con los rangos numéricos. Lo que hay en `main` desde esa
release no toca la app: el spike de transcripción, la puerta de pruebas del CI y
el cambio de `rank`.

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

## 🎙️ Transcripción y resumen de llamadas

Plan: `~/.claude/plans/genera-un-plan-robusto-wise-elephant.md`. Un bot entra a la
sala como participante visible, captura una pista por persona, transcribe con
`faster-whisper` en el host y guarda el texto cifrado con el `REPORTS_KEK`.

**El orden de las fases cambió (9-sep-2026): el resumen con IA va al final.** El
plan lo ponía en la fase 2; ahora es lo último. Sale gratis porque la degradación
ya estaba diseñada — sin resumidor, `Enabled()==false` deja la llamada en `ready`
con `SummaryError="summarizer-not-configured"`, y el transcript, que es lo
valioso, ya está. Orden nuevo: **0 → 1 → 3 → 4 → 5 → 2**.

| Fase | Qué | Estado |
|---|---|---|
| 0 | Spike: ¿llega el media desde un pod? + `rtf` del modelo | **escrita, sin medir** |
| — | `merge.py` y el filtro de `stt.py` — puros, valen con bot o con Egress | hechos, 20 mutantes muertos |
| 1 | Worker completo + ancla en el backend | no empezada |
| 3 | App: consentimiento + chip REC | no empezada |
| 4 | App: panel «Llamadas» + notificación | no empezada |
| 5 | Lectura desde fuera y la línea en el canal | no empezada |
| 2 | Resumidor (Mistral, ZDR) — **al final** | no empezada |

La fase 0 es una puerta, no un trámite: si el media no llega desde un pod y no lo
arreglan ni `rtc.tcp_port` ni `rtc.node_ip`, **el plan cambia a Egress y se
re-planifica**. No se escribe backend hasta saberlo. Las dos medidas y lo que
significan, en `docs/transcripcion.md`.

| Abierto | Owner |
|---|---|
| Desplegar `transcriber/k8s/spike.yaml` y entrar a una sala real | jose (mi `kubectl` apunta a minikube) |
| Grabar ~30 min de llamada real por pistas para el `rtf` | jose |

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

## ⏳ Planned (next iterations)

### App UI for container stats

Backend endpoint exists (above). Now consume it from `app/src/pages/ServerManage.tsx`:

- Per-service stats table: CPU%, RAM (used / limit), Net Rx/Tx, Block R/W per task.
- Poll `/api/v1/services/{id}/stats` every ~5s while the panel is open. Stop polling on navigation away.
- Show a per-row error badge when the agent returned `error` for that task (means Docker stats call failed but task exists).
- Pre-requisite: the new `swarm-manage` image (built from the in-progress endpoint) must be rolled out to each server via the "Update Agent" button.

## 💭 Future / nice-to-have

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
