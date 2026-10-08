# Integración de telemetría pasiva

Cómo una app (o la API que habla por ella) manda a cac la telemetría de sus
dispositivos para verla en **Diagnóstico** y por el **MCP**: qué se manda, qué
entiende cac de ello sin saber qué app es, y qué se configura por proyecto.

Es una integración **distinta** de la de reportes
([server-to-server.md](./server-to-server.md)): comparte con ella sólo la
credencial, la ingest key del proyecto. No crea reportes ni toca el tablero, y
lo que se manda no lo ve el cliente: es diagnóstico para el equipo.

El código que lo implementa: `backend/internal/adapters/handler/ingest.go`
(`CreateEvent`), `backend/internal/core/domain/telemetry.go` y
`telemetry_health.go`, `service/telemetry.go` y `telemetry_watch.go`.

---

## 1. El envío

```jsonc
POST https://cac.guz-studio.dev/ingest/v1/events
X-Ingest-Key: pk_…
{
  "deviceId":   "…",          // obligatorio: la identidad del dispositivo (una instalación)
  "sessionId":  "…",
  "platform":   "android",
  "appVersion": "2.3.0 (41)",
  "device":     { … },        // el estado del dispositivo (ver §2)
  "breadcrumbs": [ { … } ]    // lo que pasó (ver §3)
}
```

Contesta **202** si lo aceptó.

- **Sin CORS ni `Origin`**: está pensado para clientes nativos y servidores.
- **Límites:** 1 MiB por lote; **120 lotes por hora por dispositivo**
  (`EVENTS_RATE_LIMIT_PER_DEVICE`), por dispositivo y no por proyecto: cada
  teléfono de una flota manda a su ritmo. Pasado el límite, 429.
- **Reintentar** sólo en 5xx, 429 o fallo de red. Un 4xx no se arregla
  reintentando.
- **Sin `REPORTS_KEK` en el despliegue de cac no se guarda nada**, y el envío
  falla con 500. Todo el lote se guarda **cifrado** (AES-GCM).

### Privacidad

Antes de cifrar, cac **redacta** el lote entero: tokens, contraseñas, cabeceras
de autorización y **cualquier cadena con forma de correo, en cualquier campo**,
que se guarda como `[email]`. No hay forma de recuperarla después. No mandes
correos: para saber de quién es un dispositivo está `device.subject` (§2).

---

## 2. El dispositivo (`device`)

El `device` del último lote que lo trae es **el estado actual** del
dispositivo: lo que Diagnóstico enseña como su ficha y sobre lo que se evalúan
las reglas de salud (§5). Un lote sin `device` no borra el que había.

La forma es libre, con dos campos que cac entiende:

| Campo | Qué es |
|---|---|
| `device.label` | Cómo se le llama al dispositivo en la lista, p. ej. `"motorola moto g54 · 1042"`. |
| `device.subject` | **Quién** lo usa: un identificador estable de la persona, como un número de empleado. **Nunca un correo** (se borraría). Se puede buscar por él. |

Los dos son opcionales. Sin `label`, cac usa el fabricante y el modelo si
vienen (`manufacturer` o `brand`, y `modelName`, `model` o `deviceName`, en la
raíz de `device` o en `device.device`). Si no hay nada, enseña el principio del
`deviceId`. Un `label` o `subject` vacío no borra el que ya tenía.

Las reglas de salud miran el `device` con **rutas con puntos**:
`snapshot.battery.level` es `device.snapshot.battery.level`.

---

## 3. Los breadcrumbs

Cada breadcrumb es un objeto libre. cac usa estos campos y enseña el resto tal
cual:

| Campo | Para qué |
|---|---|
| `type` | Qué es: `network`, `error`, `lifecycle`, `heartbeat`… Se filtra por él. |
| `ts` | Cuándo pasó, en milisegundos. El timeline va **por esta hora**, no por la del lote; sin `ts`, toma la de llegada. |
| `level` | `info`, `warn`/`warning` o `error`/`fatal`. |
| `message`, `name` | La línea que se lee en el timeline. |
| `method`, `url`, `status` | Las de una petición. |

### Gravedad

La decide **cac**, igual para la app y para el MCP:

1. `type` `error`, `exception` o `unhandledrejection` → **error**, diga lo que
   diga su `level`.
2. Una petición (`network`, `request`, `fetch`, `xhr`) con `status` 0 o ≥ 400 →
   **error**. Sin `status` no se juzga.
3. Si no, su `level`: `warn`/`warning` → **aviso**; `error`/`fatal` → **error**;
   lo demás, info.

Un cambio de estado que **no es un fallo** (GPS apagado, cambio de red,
permiso revocado) va como `type: "lifecycle"` con `level: "warn"`, no como
`type: "error"`. Si no, cuenta como error, y el contador de errores deja de
decir nada.

### El latido

Un breadcrumb con `type: "heartbeat"` dice «sigo vivo». Sus demás campos
(contadores, último punto, si el rastreo seguía activo…) son libres, y se
enseñan tal cual al abrirlo. Es lo que mira el vigilante (§5): un dispositivo
que deja de mandarlo es un dispositivo callado.

---

## 4. Retención

Por proyecto, de 1 a 90 días. Sin configurar, la del despliegue
(`TELEMETRY_TTL_DAYS`, 14). La purga es cada hora, y un dispositivo sin ningún
lote guardado desaparece de la lista.

---

## 5. Configuración por proyecto

En la app: **Organización › Integraciones**, en la ficha de la integración,
sección **Telemetría**. La puede cambiar un admin de la organización. Vacía,
todo funciona como si no existiera: sin alertas ni vigilante.

- **Reglas de salud.** Cada una es `ruta`, `condición` (`==`, `!=`, `>`, `>=`,
  `<`, `<=`, `exists`, `missing`), `valor`, gravedad (aviso o error) y el
  mensaje que se enseña. Se evalúan sobre el estado actual (§2). Una ruta que
  no llegó sólo cumple `missing`. Ejemplos:
  - `snapshot.tracking.lastCallbackAgeSeconds > 600` → error, «Rastreo parado».
  - `snapshot.battery.optimizationEnabled == true` → aviso, «Batería optimizada».
- **Latido.** Cada cuánto se espera (`intervalo`, en segundos) y cuánto margen
  se da. Con una condición **«sólo mientras»** sobre el estado
  (`snapshot.tracking.active == true`), un dispositivo que no tiene por qué
  latir —alguien fuera de turno— no cuenta como callado.

El editor sugiere las rutas que tiene el estado del último dispositivo del
proyecto.

### El vigilante

Cada 5 minutos, para cada proyecto con latido o con reglas de error:

- **Callado:** debería latir («sólo mientras» se cumple) y lleva más que
  intervalo + margen sin hacerlo.
- **Mal:** su estado incumple una regla de **error**. Las de aviso sólo se
  pintan.

Avisa **una vez al empezar y otra al terminar**, nunca en cada pasada. Un
dispositivo callado más de 24 h se da por abandonado y no avisa. El aviso va
al responsable por defecto de la integración, o a toda la organización si no
tiene; a la campana de cac y al escritorio, nunca por correo. Cada persona lo
puede apagar en sus preferencias («Telemetría de dispositivos»).

---

## 6. Dónde se ve

- **Diagnóstico** en la app: la lista de dispositivos (buscable), la ficha con
  lo que se incumple, la tira de latidos con sus huecos y el timeline por hora,
  con filtros.
- **MCP**: `list_devices` (con `query`) y `get_device_timeline` (con `since`,
  `until` —también relativos: `30m`, `6h`, `2d`—, `types`, `minSeverity`). El
  resumen trae el estado aplanado, las alertas, los latidos con los huecos y
  los errores y avisos con la gravedad de cac.
- API (sesión de la org o token personal): `GET /api/v1/telemetry/devices`,
  `GET /api/v1/telemetry/devices/{projectId}/{deviceId}` y
  `GET /api/v1/telemetry/timeline`.

---

## 7. Lista para conectar

1. El proyecto existe en cac y tienes su ingest key.
2. `REPORTS_KEK` está puesta en el despliegue de cac.
3. Cada lote lleva `deviceId`, y el `device` lleva `label` y `subject` (sin
   correos).
4. Los fallos van como `error` o como petición con su `status`; los cambios de
   estado, como `lifecycle` con su `level`.
5. Si quieres el vigilante, mandas `heartbeat` y configuras el latido del
   proyecto.
