export type Severity = "info" | "warn" | "error";

/** Una regla de la ficha que se cumple (la decide el backend). */
export interface HealthAlert {
  path: string;
  severity: Severity;
  message: string;
  actual?: unknown;
}

export interface TelemetryDeviceSummary {
  deviceId: string;
  projectId: string;
  projectName: string;
  /** Cómo se llama el dispositivo. Vacío si la app no lo dice. */
  label?: string;
  /** Quién lo usa: un identificador, nunca un correo. */
  subject?: string;
  platform: string;
  appVersion: string;
  batches: number;
  reqCount: number;
  errorCount: number;
  warnCount?: number;
  lastSeen: string;
  lastHeartbeatAt?: string;
  silentSince?: string;
  alerts?: HealthAlert[];
  /** Sólo en la última fila de una página que tiene siguiente. */
  cursor?: string;
}

export interface Condition {
  path: string;
  op: "==" | "!=" | ">" | ">=" | "<" | "<=" | "exists" | "missing";
  value?: unknown;
}

export interface HealthRule extends Condition {
  severity: "warn" | "error";
  message: string;
}

export interface HeartbeatConfig {
  intervalSeconds: number;
  graceSeconds: number;
  activeWhen?: Condition;
}

export interface TelemetryConfig {
  retentionDays?: number;
  healthRules?: HealthRule[];
  heartbeat?: HeartbeatConfig;
}

export interface HeartbeatGap {
  from: string;
  to: string;
  seconds: number;
  open?: boolean;
}

/** La ficha: la última foto del dispositivo, sus alertas y sus latidos. */
export interface TelemetryDeviceDetail extends TelemetryDeviceSummary {
  firstSeen: string;
  sessionId: string;
  unhealthySince?: string;
  device: Record<string, unknown> | null;
  heartbeat?: HeartbeatConfig;
  heartbeats: string[];
  gaps: HeartbeatGap[];
}

// A breadcrumb is loosely typed: the app controls the shape. These are the
// fields the console renders; anything else is preserved for the raw view.
export interface TelemetryBreadcrumb {
  ts?: number;
  type?: string;
  category?: string;
  eventName?: string;
  /** lifecycle crumbs carry the event in `name` */
  name?: string;
  level?: string;
  message?: string;
  method?: string;
  url?: string;
  status?: number;
  [key: string]: unknown;
}

export interface TelemetryEventView {
  id: string;
  projectId: string;
  deviceId: string;
  sessionId: string;
  platform: string;
  appVersion: string;
  reqCount: number;
  errorCount: number;
  warnCount?: number;
  receivedAt: string;
  device: Record<string, unknown> | null;
  breadcrumbs: TelemetryBreadcrumb[] | null;
  /** En paralelo a `breadcrumbs`: la gravedad de cada uno. */
  severities?: Severity[];
  /** El lote existe pero no se pudo abrir. */
  undecryptable?: boolean;
}

export interface TimelineFilters {
  types: string[];
  minSeverity: Severity;
  sessionId: string;
  /** Desde hace cuántas horas; 0 = sin límite. */
  sinceHours: number;
  text: string;
}
