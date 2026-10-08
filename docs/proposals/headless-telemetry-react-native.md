# Proposal — Integración headless de telemetría para React Native (Expo)

**Status:** En ejecución (2026-07-22). **El backend YA está implementado** en cac
(endpoint `POST /ingest/v1/events` + almacenamiento cifrado + vistas admin
`devices`/`timeline` + SSE). **Falta solo el lado app** (colector RN + envío). Este
doc define esa parte. Primer consumidor: `tds-geolocation` (GEOCHECK).

**Contexto:** el widget web (`@g-studio/report-widget`) ya captura breadcrumbs
(errores, `console.error/warn`, requests fallidos, navegación) y los adjunta a un
reporte que POSTea a `POST /ingest/v1/reports` con `X-Ingest-Key`. Ese modelo es
de **navegador** (patch de `fetch`/XHR, DOM, `localStorage`, `File`) y está atado
a un reporte manual. Para móvil queremos lo mismo pero **headless y pasivo**:
registrar automáticamente **petición + respuesta + error** con **contexto rico de
dispositivo** para depurar, sin que el usuario abra ningún formulario.

Este proposal reutiliza el contrato y las garantías del widget (denylist de
pagos/auth, scrub de campos, redacción de patrones, key write-only, cifrado en
reposo con TTL) y define la variante RN + un endpoint de ingest pasivo.

---

## Objetivo

Dado un incidente ("no fichó", "el tracking se murió", "no subió la foto"), poder
reconstruir **qué pasó en ese dispositivo**: qué peticiones salieron, con qué
respondió el backend, qué errores hubo, y en qué estado estaba el equipo
(versión, red, batería, permisos). Todo pasivo, sin depender de que el usuario
reporte.

## Qué capturar

### 1. Contexto del dispositivo (adjunto a cada lote)
La app ya trae `expo-device`, `expo-application`, `expo-constants`,
`expo-network`, `expo-battery`, `expo-location`. Con eso armamos un bloque de
contexto:

| Campo | Fuente | Para qué |
|---|---|---|
| `deviceId` | `Application.getAndroidId()` / `Constants.sessionId` (ya en `deviceInfo.ts`) | correlacionar por equipo |
| `platform`, `osVersion` | `Platform.OS`, `Device.osVersion` | filtrar bugs por SO |
| `manufacturer`, `modelName`, `deviceName` | `expo-device` | reproducir en el equipo correcto |
| `isDevice` (real vs emulador) | `Device.isDevice` | descartar ruido de emulador |
| `appVersion`, `buildVersion`, `runtimeVersion` | `Application` / `Constants` | saber qué build corre |
| `networkType`, `isConnected`, `isInternetReachable` | `expo-network` | ¿fue problema de red? |
| `batteryLevel`, `lowPowerMode` | `expo-battery` | Doze / ahorro de energía mata background |
| `permissions` (location, background, activity, camera) | `expo-location` / permission service | ¿faltaba un permiso? |
| `sessionId`, `employeeId`, `shiftId` | stores de la app | correlacionar con turno/usuario |
| `trackingRuntimeProfile` | `trackingRuntime.service` | perfil de tracking activo |

### 2. Peticiones y respuestas
Cada llamada HTTP genera un breadcrumb de red **enriquecido** (más que el
`NetworkBreadcrumb` web, que solo guarda body en fallo):

```ts
type RNNetworkBreadcrumb = {
  ts: number;
  caller?: string;          // ya lo da apiLogger (p.ej. "getBootstrap")
  method: string;
  url: string;              // scrubbed (query sensible redactada)
  status: number;           // 0 = error de red
  durationMs: number;
  requestBody?: string;     // scrubbed + cap de tamaño; opt-in por allowlist de rutas
  responseBody?: string;    // scrubbed + cap; opt-in (esto es lo nuevo vs web)
  requestHeaders?: Record<string,string>; // Authorization SIEMPRE redactado
  fromCache?: boolean;
};
```

### 3. Errores
- **Errores JS no capturados** → `ErrorUtils.setGlobalHandler` (equivalente RN de
  `window.onerror`).
- **Promesas rechazadas** → tracking de unhandled rejections (RN/Hermes).
- **`console.error` / `console.warn`** → wrap pasivo.
- **Errores de negocio** → los `addLog("error"/"warn", …)` que ya existen en la app.

Reusa las shapes `ErrorBreadcrumb` / `ConsoleBreadcrumb` del widget.

## Reutilizar lo que ya existe en la app

`tds-geolocation` **ya tiene la mitad hecha**:
- `apiLogger.service.ts` construye `{caller, method, url, headers, payload, status,
  response, error}` **ya sanitizado** (trunca strings, profundidad máx).
- `testingDiagnostics.service.ts` **ya batchea y envía remoto** con toggle
  on/off y persistencia.
- Colas offline (`locationOutbox`, `event.queue`) como patrón de reintento.

⇒ La integración no reimplementa la captura: **engancha la salida del `apiLogger`
a un nuevo "sink cac"** y añade solo lo que falta (global error handler + contexto
de dispositivo + transporte al ingest de cac). Cambio acotado, no invasivo.

## Diferencias navegador → React Native

| Widget (browser) | RN / Expo |
|---|---|
| patch `window.fetch` + `XMLHttpRequest` | envolver `global.fetch` (o enganchar `apiLogger`, que ya intercepta) |
| `window.onerror` / `unhandledrejection` | `ErrorUtils.setGlobalHandler` + rejection tracker de Hermes |
| `navigator`, `document`, viewport | `expo-device` / `expo-application` / `Dimensions` |
| `localStorage` snapshot | MMKV / AsyncStorage (allowlist, nunca dump) |
| `File[]` para imágenes | `uri`/base64 (no aplica a telemetría pasiva) |
| `connect-src` CSP | permisos de red nativos (ya concedidos) |

Garantía intacta: el wrapper de red es **passthrough puro en try/catch** — nunca
bloquea, demora ni muta una petición (no puede tumbar un fichaje).

## Transporte al ingest de cac — **el backend YA existe**

> El contrato vigente está en
> [`docs/integrations/telemetry.md`](../integrations/telemetry.md). Lo de abajo es
> cómo lo usa esta app; si algo no coincide, manda el contrato.

El endpoint de telemetría pasiva **ya está implementado y montado** en cac
(no es TODO): `POST /ingest/v1/events` (`handler/ingest.go` `CreateEvent`,
ruta en `http/report.go`). Auth por `X-Ingest-Key` + rate-limit, **sin CORS**
(clientes nativos), re-redactado, cifrado en reposo (AES-GCM) y con TTL, guardado
**separado de los reportes**. También existen las vistas de consola:
`GET /api/v1/telemetry/devices` (resumen por dispositivo con `errorCount`),
`GET /api/v1/telemetry/timeline?deviceId=&sessionId=` (timeline desencriptado).
Nota: los events **no** pasan por el hub SSE (`GET /api/v1/events` es el stream de
*reportes*); se dejaron fuera a propósito por volumen.

### Límites del endpoint (a respetar desde la app)
- **Rate limit por dispositivo** (no por proyecto): `EVENTS_RATE_LIMIT_PER_DEVICE`,
  default **120 req/hora/device**. El limiter de reportes (20/h por proyecto) NO
  aplica aquí — son perfiles de tráfico distintos.
- **Body máximo por batch: 1 MiB.**
- Política de envío en la app: flush periódico cada **5 min**, o al llegar a 20
  crumbs, o ante un error (con cooldown de 20 s para no tormentear). Reintento
  solo en 5xx/429/red; en 4xx se descarta el batch.

### Contrato real (`IngestEventBatch`)
```jsonc
POST /ingest/v1/events
Header: X-Ingest-Key: pk_…
{
  "deviceId":  "…",          // required (index)
  "sessionId": "…",
  "platform":  "android|ios",
  "appVersion":"1.0.0",
  "device":    { … },        // contexto de dispositivo (se cifra)
  "breadcrumbs": [ … ]       // se cifran; ver tipos abajo
}
```

**Clave para que los errores cuenten como error en bk** (`Summarize()` del backend):
- Red → `type: "network" | "request" | "fetch" | "xhr"` con `status`; **`status === 0`
  o `>= 400` cuenta como error**.
- Error → `type: "error" | "unhandledrejection" | "exception"`.

Si el breadcrumb no usa esos `type`, el backend lo guarda pero **no lo cuenta como
error** → ese es justo el motivo por el que "solo salen rechazados". El emisor RN
debe respetar estos `type`.

Envío desde la app: buffer en memoria → flush por tamaño/tiempo → si falla, cola
persistente y reintento (mismo patrón que el outbox de ubicaciones). Flush
oportuno en foreground y ante error.

## Seguridad y privacidad (heredado del widget)

- `X-Ingest-Key` es **write-only** (modelo Sentry-DSN); no lee nada.
- **Denylist dura** de hosts de pago/auth (nunca body/query; a lo sumo host+status).
- **Scrub** recursivo de campos sensibles (`authorization`, `password`, `token`,
  …) + redacción de patrones (Bearer, emails) — reusar la lista del widget.
- **Response bodies**: sensibles → por defecto solo metadata (status/duración);
  body **opt-in por allowlist de rutas** + scrub + cap de tamaño.
- Servidor **re-redacta y cifra en reposo (AES-GCM)** con TTL de retención.
- Toggle global on/off (como `testingDiagnostics`) y respeto a datos de prueba vs
  producción.

## Plan por fases

1. **Contexto de dispositivo**: helper `collectDeviceContext()` sobre los módulos
   expo ya instalados. (App-only, rápido.)
2. **Sink cac**: enganchar `apiLogger` → breadcrumbs de red enriquecidos
   (req+resp, scrubbed, `type:"network"`+`status`) + `ErrorUtils`/rejections/console
   (`type:"error"/"exception"`). (App-only.)
3. **Emitir errores del background task**: los caminos de fallo de
   `location.task.ts` (fallback offline, `missing_upload_config`, timeout, HTTP
   error, descartado) hoy solo hacen `addLog` local → deben producir breadcrumb de
   error. **Este es el hueco por el que "solo salen rechazados".** (App-only.)
4. **Transporte + buffer/cola** → `POST /ingest/v1/events` con `X-Ingest-Key`,
   flush y reintento offline (patrón del outbox de ubicaciones).
5. ✅ **Backend** (`/ingest/v1/events` + telemetry storage + admin + SSE) — **ya
   implementado en cac**. Solo falta apuntar la app.
6. **Consola de triage**: `devices`/`timeline` ya exponen los datos; conectar la
   vista en la app Tauri (o usar el SSE) para ver req/resp/errores por dispositivo.

Fases 1-4 son app-only y desbloquean ver los errores en bk de inmediato (el backend
ya recibe y clasifica).

## Diagnóstico de cortes de tracking (señales + vista de huecos)

Objetivo concreto: *por qué se corta el registro de puntos, dónde y en qué device*.

### Señales que la app ya emite a cac (implementadas en `tds-geolocation`)
- **Ubicación en cada breadcrump de red** (`lat`/`lon`) + `lastKnownLocation` en el device
  context → *dónde* ocurrió el corte.
- **Heartbeat** cada 120s (`type:"heartbeat"`, con `trackingActive` y última ubicación) →
  un hueco en los heartbeats del servidor = corte, aunque nada haya fallado.
- **Marcadores de ciclo de vida** (`type:"lifecycle"`), con última ubicación:
  - `tracking_started` / `tracking_stopped` / `tracking_stop_failed`
  - `tracking_stopped_permission_change` (permiso revocado a mitad de turno)
  - `battery_protection_enabled` (low-power / optimización de batería)
  - `airplane_mode_enabled`
  - `mock_location_detected`
  - `device_rebooted` (BootReceiver nativo → flag consumido en el arranque de JS)
  - `app_active` / `app_background`
- **Errores** (`type:"error"/"exception"`) del path de background que antes solo iban a
  `addLog` local (fallo directo, timeout, `missing_upload_config`, descarte).

Todo con `trackingActive` para saber si el seguimiento debía estar activo en cada evento.

### Vista de huecos en cac — hecho (7-oct-2026), genérico

Lo que quedó, sin nada propio de esta app (todo lo dice la app en el lote o el
proyecto en su configuración; el contrato está en
[`docs/integrations/telemetry.md`](../integrations/telemetry.md)):

1. **Nombre y persona**: `device.label` y `device.subject` (un id, nunca un
   correo — se borran en el ingest). Fila por dispositivo en `telemetry_devices`,
   con búsqueda y paginación.
2. **Gravedad única** en el backend (`domain.CrumbSeverity`): la app y el MCP la
   leen del timeline. Un evento de dispositivo que no es un fallo va como
   `lifecycle` con `level: warn`.
3. **Ficha** como árbol, con **reglas de salud** por proyecto (`ruta op valor`,
   aviso o error) evaluadas sobre el último estado.
4. **Latidos y huecos**: la tira de latidos marca los huecos mayores que el
   intervalo más el margen del proyecto; el MCP los devuelve en
   `heartbeats.gaps`.
5. **El vigilante** (cada 5 min): un dispositivo que debería latir (`activeWhen`
   sobre su estado) y se calla, o que incumple una regla de error, avisa en la
   campana una vez al abrirse y otra al cerrarse. Un dispositivo callado más de
   24 h se da por abandonado y no avisa.

Pendiente de aquí: la **causa probable** de cada hueco (el último
`lifecycle`/`error` anterior) y el lugar. Se leen hoy en el timeline alrededor
del hueco, pero no se calculan.

## Decisiones abiertas

- **¿Publicar como paquete RN** (`@g-studio/report-native`) reutilizable, o
  integrarlo inline en `tds-geolocation` primero y extraer después? (Sugerido:
  inline primero, extraer cuando haya 2º consumidor — como pasó con el widget web.)
- **Volumen**: telemetría pasiva de red puede ser mucha; definir muestreo
  (¿solo errores + N% de éxitos?) y caps de retención.
- **Response bodies**: ¿allowlist explícita de rutas, o solo en fallo? (privacidad
  vs utilidad de depuración).
- **Correlación**: incluir un `traceId` por request para casar app↔backend.
