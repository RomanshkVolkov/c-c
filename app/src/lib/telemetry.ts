import type {
  HeartbeatGap,
  Severity,
  TelemetryBreadcrumb,
  TelemetryDeviceSummary,
  TelemetryEventView,
} from "@/types/telemetry";

/**
 * Lo que la pantalla de Diagnóstico hace con los datos, sin pintar nada.
 *
 * Aparte para probarlo sin montar la pantalla, y porque son las reglas que
 * importan: en qué orden va el timeline, qué cuenta como hueco, cómo se llama
 * un dispositivo. La gravedad **no** se decide aquí: la manda el backend con
 * cada crumb, la misma que ve el MCP.
 */

/** Cómo se le llama a un dispositivo: su nombre, o el principio del id. */
export function deviceTitle(d: Pick<TelemetryDeviceSummary, "label" | "deviceId">): string {
  return d.label?.trim() || shortId(d.deviceId);
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** Una fila del timeline plano. */
export interface TimelineRow {
  key: string;
  /** Milisegundos: el `ts` del crumb, o la llegada del lote si no lo trae. */
  at: number;
  crumb: TelemetryBreadcrumb;
  severity: Severity;
  batchId: string;
  sessionId: string;
  /** La primera fila (en orden de pantalla) de otra sesión. */
  sessionStart: boolean;
}

/**
 * Los lotes, aplanados en una sola lista por hora, la más nueva arriba.
 *
 * Por el `ts` del crumb y no por el lote: un lote junta lo que pasó en minutos,
 * y agrupado por lote un error de las 10:05 salía debajo de una petición de las
 * 10:01 del lote siguiente. Un crumb sin `ts` toma la hora de su lote. A igual
 * hora se respeta el orden en que llegaron.
 */
export function flattenTimeline(batches: TelemetryEventView[]): TimelineRow[] {
  const rows: (TimelineRow & { seq: number })[] = [];
  let seq = 0;
  for (const b of batches) {
    const fallback = Date.parse(b.receivedAt);
    (b.breadcrumbs ?? []).forEach((crumb, i) => {
      const ts = typeof crumb.ts === "number" && Number.isFinite(crumb.ts) ? crumb.ts : fallback;
      rows.push({
        key: `${b.id}:${i}`,
        at: ts,
        crumb,
        severity: b.severities?.[i] ?? "info",
        batchId: b.id,
        sessionId: b.sessionId,
        sessionStart: false,
        seq: seq++,
      });
    });
  }
  rows.sort((a, b) => b.at - a.at || b.seq - a.seq);
  let prev: string | null = null;
  return rows.map(({ seq: _seq, ...r }) => {
    const start = prev !== null && r.sessionId !== prev;
    prev = r.sessionId;
    return { ...r, sessionStart: start };
  });
}

/** Los campos que un crumb ya enseña en su línea; el resto es su contenido. */
const SHOWN = new Set(["type", "ts", "level", "message", "name", "eventName", "category", "method", "url", "status"]);

/**
 * El contenido de un crumb, sin lo que ya se lee en su línea. Es lo que hace
 * legible un latido: sus contadores, su último punto, si el rastreo seguía
 * activo — antes sólo se veía «heartbeat».
 */
export function crumbFields(crumb: TelemetryBreadcrumb): [string, unknown][] {
  return Object.entries(crumb).filter(([k]) => !SHOWN.has(k));
}

/** La línea de un crumb. */
export function crumbTitle(crumb: TelemetryBreadcrumb): string {
  if (crumb.type === "network" || crumb.type === "request" || crumb.type === "fetch" || crumb.type === "xhr") {
    return [crumb.method, crumb.url].filter(Boolean).join(" ");
  }
  return String(crumb.message || crumb.name || crumb.eventName || crumb.type || "event");
}

/** Si una fila contiene el texto (en su línea o en su contenido). */
export function matchesText(row: TimelineRow, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return JSON.stringify(row.crumb).toLowerCase().includes(q);
}

/** Los tipos que aparecen, para ofrecerlos como filtro. */
export function crumbTypes(batches: TelemetryEventView[]): string[] {
  const set = new Set<string>();
  for (const b of batches) for (const c of b.breadcrumbs ?? []) if (c.type) set.add(c.type);
  return [...set].sort();
}

/** Un punto o un tramo de la tira de latidos, en fracciones de la ventana. */
export interface StripMark {
  left: number;
  width: number;
  kind: "beat" | "gap";
  open?: boolean;
  from: string;
  to: string;
}

/**
 * La tira de latidos: un punto por latido y una banda por hueco, colocados en
 * la ventana [from, to]. Lo que cae fuera se recorta.
 */
export function heartbeatStrip(beats: string[], gaps: HeartbeatGap[], from: number, to: number): StripMark[] {
  const span = to - from;
  if (!(span > 0)) return [];
  const pos = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
  const marks: StripMark[] = [];
  for (const g of gaps) {
    const a = pos(Date.parse(g.from));
    const b = pos(Date.parse(g.to));
    if (b > a) marks.push({ left: a, width: b - a, kind: "gap", open: g.open, from: g.from, to: g.to });
  }
  for (const s of beats) {
    const t = Date.parse(s);
    if (t < from || t > to) continue;
    marks.push({ left: pos(t), width: 0, kind: "beat", from: s, to: s });
  }
  return marks;
}

/** Cuánto dura un hueco, en palabras cortas («2 h 5 min»). */
export function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
