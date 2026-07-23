# Proposal — Integración headless de telemetría para React Native (Expo)

**Status:** Borrador (2026-07-22). Diseño para conectar apps móviles RN/Expo al
ingest de **cac** como fuente de telemetría de depuración (peticiones, respuestas
y errores), sin UI. Primer consumidor: `tds-geolocation` (GEOCHECK).

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

## Transporte al ingest de cac

Hoy el backend solo ingesta telemetría **adjunta a un reporte**
(`POST /ingest/v1/reports`, campo `telemetry`, guardado como `TelemetryJSON`,
rate-limited por `X-Ingest-Key`). Para telemetría pasiva proponemos:

- **Opción A (stopgap, sin tocar backend):** enviar un "reporte" sintético de baja
  prioridad por lote de breadcrumbs. Funciona ya, pero ensucia la bandeja de
  reportes. Solo para validar el pipe.
- **Opción B (recomendada, backend TODO):** endpoint dedicado
  **`POST /ingest/v1/events`** que acepte lotes de breadcrumbs + contexto de
  dispositivo, mismo `X-Ingest-Key` write-only, mismo rate-limit/cifrado/TTL, y los
  persista separados de los reportes (para triage/diagnóstico, no bandeja).

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
   (req+resp, scrubbed) + `ErrorUtils`/rejections/console. (App-only.)
3. **Transporte + buffer/cola** con `X-Ingest-Key`, flush y reintento offline.
4. **Backend `POST /ingest/v1/events`** (Opción B) + persistencia/TTL/cifrado.
5. **Consola de triage** en la app Tauri: ver por dispositivo/turno la secuencia
   de req/resp/errores. (Reusa infra de reportes.)

Fases 1-3 desbloquean captura + envío sin tocar backend (vía Opción A);
Fase 4 lo vuelve limpio y escalable.

## Decisiones abiertas

- **¿Publicar como paquete RN** (`@g-studio/report-native`) reutilizable, o
  integrarlo inline en `tds-geolocation` primero y extraer después? (Sugerido:
  inline primero, extraer cuando haya 2º consumidor — como pasó con el widget web.)
- **Volumen**: telemetría pasiva de red puede ser mucha; definir muestreo
  (¿solo errores + N% de éxitos?) y caps de retención.
- **Response bodies**: ¿allowlist explícita de rutas, o solo en fallo? (privacidad
  vs utilidad de depuración).
- **Correlación**: incluir un `traceId` por request para casar app↔backend.
