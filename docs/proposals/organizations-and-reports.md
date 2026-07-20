# Proposal — Organizations + módulo de reportes (bug tracker multi-tenant)

**Status:** Draft / no implementado.
**Contexto:** damos soporte a webs de clientes de dos empresas de software. Portento
(cliente de nuke) ya tiene un módulo interno completo de bug-tickets; un segundo
cliente pidió el mismo módulo. En vez de replicar el módulo web por web, cac se
extiende para ser el tracker central: el backend Go ingesta y persiste los
reportes, la app Tauri es la consola de triage, y un widget embeddable captura
los reportes en cada web. ClickUp queda fuera de la arquitectura (solo se usaba
kanban/calendario/docs, todo cubierto aquí).

Este proposal absorbe y extiende [groups-and-sharing.md](./groups-and-sharing.md):
el concepto "group" se renombra a **organization** y pasa de propuesta a
requisito, porque separa las dos empresas tanto en servidores como en reportes.

## Decisiones tomadas

1. **cac ES el tracker** (no un ingester hacia ClickUp). El kanban/estados/comentarios
   ya están diseñados y probados en portento; se portan.
2. **Imágenes vía image-service** (`~/projects/image-service`), que ya es
   multi-tenant (cert CN + API key por proyecto, storage propio por proyecto) y ya
   lo usan portento y marvi. El backend de cac es *un cliente más* de image-service.
3. **Storage con Terraform**, calcando `marvi-inmobiliaria/infra/terraform/media`
   pero **sin CloudFront**: los screenshots de bugs pueden contener datos de
   usuarios finales → bucket S3 privado y serving exclusivamente por proxy
   autenticado del backend (mismo patrón que portento usa para sus imágenes).
4. **Snapshots de localStorage/cookies: opt-in por integración, nunca default.**
   El volcado wholesale de portento (base64 reversible, gotcha documentado) no
   se copia: en multi-tenant, un dump de localStorage de webs ajenas acumularía
   JWTs/PII de usuarios finales de terceros (brecha del tracker = sesiones
   robadas en todas las webs cliente). En su lugar, el dev que integra el
   widget configura una **allowlist de keys** (`snapshot.localStorage:
   ['feature-flags', …]`) y/o un callback `context()` con datos curados. El
   servicio aplica: redacción de patrones tipo token (JWT `eyJ…`, `Bearer`,
   emails), **cifrado at-rest AES-GCM con KEK** (mismo patrón que image-service
   usa para las creds de storage), cap de tamaño (~20 KB) y TTL de retención
   (30–60 días, purga automática del snapshot sin borrar el reporte). Cookies:
   default off (solo `document.cookie`, no-HttpOnly, si se habilita).
5. **Portento no se toca.** Su módulo interno sigue; migrar portento a este
   servicio es una decisión futura e independiente. El segundo cliente arranca
   como primer tenant.
6. **Sync one-way opcional a ClickUp: descartado** (uso real de ClickUp era
   kanban/calendario/mds — cubierto por la app Tauri y los docs del repo).
7. **Telemetría de breadcrumbs en el SDK (el valor real, bajo riesgo).** El
   paquete npm instala listeners al inicializarse y mantiene ring buffers en
   memoria que se adjuntan al enviar un reporte:
   - **Errores JS**: `window.onerror` + `unhandledrejection` (mensaje, stack,
     archivo:línea) — últimos ~20.
   - **Consola**: patch de `console.error`/`console.warn` (no `log`) — últimas
     ~30 entradas, truncadas a ~500 chars c/u.
   - **Requests fallidos**: patch de `fetch`/XHR — método, URL, status code,
     duración. Headers nunca; solo fallos (4xx/5xx/network error), últimos ~20.
   - **Bodies de requests (opt-in dirigido)**: para el caso "mandé el
     formulario y falló", el dev declara `captureBodies: ['/api/checkout',
     '/api/forms/*']` (allowlist de rutas). Solo requests fallidos, solo
     JSON/form-encoded (nada binario/multipart), truncado ~4 KB. **El scrub
     corre en el SDK antes de enviar** — denylist recursiva de campos
     (`password`, `token`, `secret`, `card`, `cvv`, `ssn`, …, extensible con
     `scrubFields: ['rfc', 'curp']`) → `"[redacted]"` — el body crudo nunca
     sale del browser; el server re-aplica redacción de patrones (defensa en
     profundidad).
   - **Navegación**: cambios de ruta (breadcrumb de "qué hizo antes del bug").
   Guardas: scrub de query strings en URLs (`?token=`, `?code=`…), redacción de
   patrones (JWT/emails), cap total ~30 KB, mismo cifrado at-rest y TTL que los
   snapshots (columna `reports.telemetry` + `telemetry_purge_at`). La consola
   Tauri lo pinta como línea de tiempo en el detalle del ticket.

   **Zonas prohibidas y no-interferencia (pagos/auth):**
   - **Denylist dura de hosts** embebida en el SDK — `*.stripe.com`,
     `*.paypal.com`, `*.mercadopago.com`, `*.conekta.io`, `*.openpay.mx`,
     `*.auth0.com`, `accounts.google.com`, … — que **anula cualquier
     `captureBodies` del integrador**: para esos hosts nunca se captura body ni
     query (el `client_secret` de Stripe viaja en la URL del PaymentIntent); a
     lo sumo host + status code (útil para "el pago falló") — configurable
     apagarlo del todo por project.
   - **Passthrough puro**: el patch de `fetch`/XHR no modifica, bloquea,
     retrasa ni reintenta requests; toda la lógica de telemetría corre en
     `try/catch` — si el SDK falla, el request original sale intacto. El widget
     jamás puede ser causa de un pago/login fallido.
   - Los campos de tarjeta de Stripe Elements/Checkout viven en iframes
     cross-origin: el patch ni siquiera los ve (defensa adicional, no la
     principal).
   - Buffers **solo en memoria** (el SDK no persiste nada en el
     localStorage/sessionStorage del sitio) y sin `eval`/inline scripts — no
     exige aflojar la CSP del sitio; el integrador solo agrega el dominio del
     ingest a `connect-src`.

## Arquitectura

```
web cliente 1..N                      app Tauri (consola jose/equipo)
┌────────────────┐                       │ JWT (org-scoped)
│ widget snippet │                       ▼
│  (captura)     │──POST /ingest/v1──▶ backend Go (cac) ──▶ Postgres
└────────────────┘   ingest_key          │        │
                                         │        └──▶ SSE (notifs a la app)
        imágenes (multipart) ────────────┼──▶ image-service ──▶ S3 privado
                                         │         (proyecto "cac-reports")
   portal web del cliente (fase 6) ──────┘
   "mis reportes" + comentarios
```

Tres superficies; Tauri cubre solo la consola:

| Superficie | Quién | Tecnología |
|---|---|---|
| Ingest | webs de clientes (anónimo/reporter) | backend Go, key write-only por project |
| Consola de triage | jose / equipo por org | app Tauri (extiende cac) |
| Portal "mis reportes" | usuarios finales del cliente | web mínima (fase 6, lo único no-Tauri) |

## Modelo de datos

Sobre el modelo de groups-and-sharing, renombrado y extendido:

```
organizations                     -- nuke, <empresa 2>
  id uuid pk, name, slug unique, created_at, updated_at

org_memberships
  org_id fk, user_id fk, role varchar(20)   -- 'admin' | 'member' | 'viewer'
  pk (org_id, user_id)

servers
  + org_id fk → organizations     -- separa los servidores por empresa

collections
  + org_id fk nullable            -- null = colección personal (owner_user_id)

report_projects                   -- una web cliente (portento, cliente-2, …)
  id uuid pk, org_id fk, name, slug unique
  ingest_key_hash bytea           -- HMAC de la key write-only (se muestra 1 vez)
  allowed_origins text[]          -- CORS del ingest
  rate_limit_per_hour int default 20
  default_assignee_user_id fk nullable  -- reportes nuevos nacen asignados a este agente
  is_active bool
  created_at, updated_at

reports
  id uuid pk, project_id fk
  seq int                         -- folio corto por proyecto (PROJ-123)
  title varchar(200), description text
  status varchar(20)              -- pending | in_progress | resolved | closed
  url text, user_agent text, viewport varchar(50)
  telemetry bytea nullable        -- blob cifrado (AES-GCM): breadcrumbs del SDK
                                  -- {errors[], console[], network[], nav[]} — ver decisión 7
  telemetry_purge_at timestamptz  -- TTL: purga del blob sin borrar el reporte
  reporter_name varchar(120), reporter_email varchar(255)   -- sin cuenta en v1
  assignee_user_id fk nullable
  resolved_at timestamptz nullable
  created_at, updated_at, deleted_at (soft delete)

report_comments
  id uuid pk, report_id fk
  kind varchar(10)                -- 'user' | 'system' (marcas automáticas)
  author_user_id fk nullable      -- null = comentario del reporter (portal/email)
  body text
  created_at, updated_at, deleted_at

report_images
  id uuid pk, report_id fk, comment_id fk nullable  -- null = galería del reporte
  path text                       -- key devuelta por image-service
  file_name varchar(255)
  created_at, deleted_at
```

Máquina de estados (única fuente de verdad, server-side; copia el
`BUG_TICKET_VALID_TRANSITIONS` de portento y evita su gotcha de duplicarla en
cliente — la app Tauri la consume de un endpoint/const compartida):

```
pending     → in_progress | closed
in_progress → pending | resolved | closed
resolved    → in_progress | closed
closed      → (terminal)
```

`resolved_at` se setea al pasar a resolved y NO se limpia al reabrir (decisión
heredada de portento, documentada).

## Scoping / visibilidad

- JWT actual de cac + membership: un usuario ve solo las orgs donde tiene
  membership; `jose` tiene membership admin en ambas.
- Todos los list/detail endpoints de servers, collections (org), report_projects
  y reports filtran por `org_id ∈ memberships(caller)`.
- El ingest NO usa JWT: autentica por `ingest_key` del project (write-only:
  solo puede crear reportes y adjuntar imágenes al reporte recién creado).

## Fases

### Fase 1 — Organizations en cac (backend + app)

- Migración: `organizations`, `org_memberships`; `servers.org_id`,
  `collections.org_id` (nullable). Org "default" inicial + backfill.
- Endpoints CRUD de orgs/members (los del proposal de groups, renombrados).
- Middleware de scoping (claims + membership).
- App Tauri: switcher de organización (header), listas filtradas.
- **Valor inmediato aunque los reportes tardaran** (separa servidores por empresa).

### Fase 2 — Infra AWS con Terraform

`infra/terraform/reports-media/` calcado de marvi (`s3.tf`, `iam.tf`,
`variables.tf`, `outputs.tf`) con estas diferencias:

- **Sin `cloudfront.tf`**: bucket 100% privado (public access block total);
  el serving es solo por proxy del backend. Menos infra y screenshots nunca
  públicos.
- Un solo bucket `guz-reports-media` con prefijos `org/<slug>/project/<slug>/…`
  (separar buckets por org solo si algún día un cliente exige aislamiento duro).
- IAM user para image-service (mismo `iam.tf` de marvi).
- Output `project_admin_command` → registrar en image-service:
  `project-admin create-s3 "CAC Reports" cac-reports <ACCESS> <SECRET> <region> guz-reports-media`.
- Backend cac guarda `IMAGE_SERVICE_URL/CERT_CN/API_KEY` (env, mismo wiring que
  portento/marvi).

### Fase 3 — Dominio reports en el backend Go

- Modelos GORM + repos + services (hexagonal como el resto de cac).
- **Ingest público**:
  - `POST /ingest/v1/reports` — multipart: campos + hasta 5 imágenes.
    Auth por `X-Ingest-Key` (HMAC compare), CORS restringido a
    `allowed_origins`, rate limit por key (`rate_limit_per_hour`, default 20 —
    hereda el anti-spam 10/h de portento pero configurable).
  - **Validación de imágenes (portento):** máx **5 por reporte**, mime
    `png/jpeg/webp/gif`, ~5 MB c/u (el tope duro de 30 MB lo pone image-service).
  - Backend reenvía las imágenes a image-service (`/upload`, comprime a webp)
    y persiste los paths. Cliente jamás toca image-service ni S3.
  - **Auto-asignación:** si el project tiene `default_assignee_user_id`, el
    reporte nace asignado (portento auto-asigna a un `DEFAULT_ASSIGNEE_ID`).
  - **Reportes de sistema (dedup por título)** — heredado de
    `createSystemBugTicket`: para reportes automáticos (errores recurrentes que
    el SDK detecte, o procesos del backend), **deduplicar por título** contra los
    reports abiertos (`pending`/`in_progress`) del mismo project, para que los
    reintentos no llenen el tablero. Marcarlos con un flag/origen `system`.
- **API admin (JWT, org-scoped)**:
  - CRUD `report_projects` (crear muestra la ingest key 1 sola vez).
  - `GET /reports` (filtros: project, status, assignee, rango fechas),
    `GET/PATCH /reports/{id}` (transiciones validadas, asignar),
    comentarios CRUD (autor edita/borra lo suyo; `kind=system` inmutable),
    imágenes de galería (attach/detach deja comentario system, como portento).
  - **Comentarios `system` como audit trail (portento):** cambios de estado y
    attach/detach de imágenes dejan un comentario `kind=system` en el hilo
    (inmutable), visible también en el portal del cliente. Cuerpo del comentario
    de usuario puede ir vacío si trae imagen.
  - `GET /reports/{id}/images/{imageID}` — proxy autenticado con scoping por
    report (anti-IDOR), `Cache-Control: private, no-store`.
- **Notificaciones**: endpoint SSE org-scoped (`/api/v1/events`) para la app;
  eventos `report:new`, `report:comment`, `report:status`, `report:attachment`.
  **Ruteo (heredado de portento):**
  - `report:new` → agentes del org (o directo al `default_assignee` si existe).
  - `report:status` al pasar a `resolved` → **reporter** (por magic link).
  - comentario de **agente** → reporter; comentario de **reporter** → el
    `assignee`, o **broadcast a los agentes del project** si no hay assignee.
  - attach/detach de galería → reporter. Preview = body o `📎 N imagen(es)`.
- Gotcha de portento que se corrige de origen: el conteo de imágenes SIEMPRE
  filtra `comment_id IS NULL` para la galería.

### Fase 4 — Consola en la app Tauri

- Sección "Reportes": org switcher → projects → tablero.
- **Kanban** 4 columnas con drag&drop optimista + revert — portar
  `kanban-board.tsx` de portento (React, adaptar HeroUI→shadcn).
- **Calendario** mensual con drawer por día y vista mobile compacta — portar
  `work-orders-calendar.tsx` (recién pulido en portento).
- **Detalle**: galería + zoom, comentarios con imágenes inline
  (paste/adjuntar, Enter envía), select de estado con transiciones válidas, y
  **línea de tiempo de telemetría** (decisión 7): navegación → request fallido
  (status) → error de consola/JS, ordenados por timestamp, con "Copiar" por
  entrada (como los snapshots decodificados del detalle SWE de portento).
- Imágenes en el webview: `<img>` no manda Authorization → el backend emite
  **URLs firmadas cortas** (HMAC + exp ~5 min, query param) para la app; el
  proxy valida firma o JWT indistintamente.
- Notificaciones nativas del OS vía SSE + `tauri-plugin-notification`.

### Fase 5 — Widget embeddable (paquete npm + script fallback)

- **Paquete npm `@guz-studio/report-widget`** como integración first-class: el
  stack de las webs soportadas es casi siempre React/Next. API:

  ```tsx
  <ReportWidget
    projectKey="pk_…"
    snapshot={{ localStorage: ['feature-flags', 'app-state'], cookies: false }}
    context={() => ({ userId: session.user.id, appVersion: APP_VERSION })}
    theme={{ color: '#…', position: 'bottom-right' }}
  />
  ```

  El componente porta la *captura* del `bug-report-widget.tsx` de portento
  (URL, userAgent, viewport, imágenes file picker / paste, `<details>` "qué se
  enviará") **más la telemetría de breadcrumbs de la decisión 7** (errores JS,
  console.error/warn, requests fallidos con status code, navegación), que se
  recolecta pasivamente desde el init y se adjunta al enviar.
- **Fallback `widget.js`** vanilla/Preact compilado (un solo `.js`, sin peer
  deps) para sitios no-React:
  `<script src="https://cac.guz-studio.dev/widget.js" data-project-key="…">`.
- Snapshots según decisión 4: allowlist + `context()`; la redacción/cifrado/TTL
  se aplican server-side (el widget no es frontera de confianza).
- POST directo al ingest con la key pública write-only (modelo DSN de Sentry).

### Fase 6 — Portal del cliente (web; lo único fuera de Tauri)

- Requisito real del segundo cliente: "ver mis reportes y comentar con imágenes".
- v1 sin cuentas: **magic link por email** — el ingest pide `reporter_email`,
  cada reporte manda un link firmado a `/r/{token}` donde el reporter ve SU
  reporte y comenta (equivalente al share-token de work-orders de portento).
- v2 (si lo piden): listado "todos mis reportes" con OTP por email; embebible
  por iframe en la web del cliente.
- Nunca expone userAgent/viewport de otros ni datos internos (aprende de
  `getMyBugTicketByID` de portento: select explícito sin campos sensibles).

## Rendimiento / costos

- **Tauri**: kanban/calendario con cientos de tickets es carga trivial de
  webview (~100-200 MB RAM). Sin riesgo.
- **Go ingest**: miles req/s en un pod chico; el volumen real será decenas/día.
  Las imágenes pesadas (5 MB) pasan por el backend → image-service en
  streaming multipart; si algún día pesa, se separa el upload en un endpoint
  con límite de concurrencia. No optimizar antes.
- **Costos AWS**: solo S3 (centavos/mes a este volumen; lifecycle rule de
  multipart incompletos como marvi). Sin CloudFront. Backend y Postgres ya
  corren en el k8s existente → costo marginal ≈ storage. Comparado con
  suscripción de ClickUp: gana self-hosted y es infra propia.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Abuso del ingest (key es pública en el JS del cliente) | write-only + rate limit por key + CORS por origin + `is_active` para revocar; rotación de key por project |
| Screenshots con datos sensibles | bucket privado, proxy autenticado, sin CDN; URLs firmadas de vida corta |
| Snapshots con tokens/PII de usuarios finales de terceros | opt-in con allowlist (nunca dump completo), redacción de patrones token, cifrado at-rest (KEK), TTL de purga — ver decisión 4 |
| Captura toca flujos de pago/auth (PCI, sesiones) | denylist dura de hosts de pago/auth que anula el allowlist del dev; patch fetch/XHR passthrough puro en try/catch (jamás altera el request) — ver decisión 7 |
| Drift de la máquina de estados server/cliente (gotcha portento) | la app consume las transiciones del backend (endpoint/const generada), no copia local |
| Reescritura Go del dominio (no se reusa el server TS de portento) | el dominio es chico y `docs/bug-tickets.md` de portento es la spec funcional; los componentes React sí se portan |
| Dos fuentes de verdad si portento no migra | aceptado: portento es interno y autónomo; revisitar migración cuando el servicio esté estable |

## Aclaraciones de implementación (2026-07-20, sesión de ejecución)

Huecos detectados al ejecutar Fase 3 (la idea se formó en otra sesión); decisiones
tomadas, coherentes con lo ya construido:

1. **Roles de la consola sobre reports** (no especificado): `viewer` = solo
   lectura; `member`+ = triage completo (transiciones, asignar, comentar,
   imágenes); `admin` = además delete/rotate-key de report_projects.
2. **Anti-IDOR**: un caller sin membership en la org del reporte recibe **404**
   (no 403) para no filtrar existencia de reportes ajenos.
3. **Paginación de `GET /reports`**: `limit` (default 50, max 200) + `offset`,
   respuesta incluye `total`.
4. **Endpoint de la máquina de estados**: `GET /api/v1/reports/transitions`.
5. **Comentarios system** también para transiciones de estado y (des)asignación
   (`status: pending → in_progress`), no solo attach/detach de galería — alimenta
   la línea de tiempo de la consola.
6. **`resolved_at`**: se setea en cada paso a resolved (pisa el valor anterior) y
   NO se limpia al reabrir (decisión heredada de portento).
7. **Assignee**: debe tener membership en la org del proyecto (400 si no).
8. **Snapshots (decisión 4) sin columna propia en el schema**: pendiente decidir
   si van dentro del blob `telemetry` o en columna aparte — se resuelve en Fase 5
   cuando el widget los mande. El ingest aún no acepta `telemetry`/`snapshot`;
   esa extensión llega con Fase 5 (cifrado AES-GCM con KEK vía env `REPORTS_KEK`).
9. **SSE (Fase 3)**: `EventSource` no manda headers → el endpoint acepta
   `?token=` (access token) además de `Authorization`.
10. **Rate limit del ingest**: en memoria por pod (ventana deslizante 1h). Con
    réplicas es límite soft por-pod; store compartido solo si aparece abuso real.
11. **Ingest key**: formato `pk_…` (24 bytes aleatorios), almacenada solo como
    HMAC-SHA256 con `INGEST_KEY_SECRET` (env), comparación constant-time.

## Orden de implementación sugerido

1. Fase 1 (orgs) — desbloquea la separación de empresas ya.
2. Fase 2 (terraform + registro en image-service) — 1 sesión, es calcar marvi.
3. Fase 3 (dominio + ingest) — el grueso del backend.
4. Fase 5 (widget) antes que la 4 si el segundo cliente urge: con ingest +
   widget ya se reciben reportes (triage temporal vía API/SQL), y la consola
   Tauri llega después.
5. Fase 4 (consola Tauri).
6. Fase 6 (portal) cuando el cliente lo pida explícitamente.
