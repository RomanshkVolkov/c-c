import type { MessageKey } from "@/lib/i18n";

export type ReportStatus = "open" | "in_progress" | "done" | "closed";

export const REPORT_STATUSES: ReportStatus[] = [
  "open",
  "in_progress",
  "done",
  "closed",
];

/**
 * Cómo se llama cada estado, **por clave de catálogo**.
 *
 * El identificador es el que manda: `done` es un estado, «Hecha» es cómo se lee
 * hoy en esta pantalla. Guardar aquí la palabra traducida ataría la lógica al
 * idioma — y el repositorio ya avisa en cuatro sitios de que renombrar una
 * columna no cambia lo que esa columna *es*.
 */
export const STATUS_LABEL_KEYS: Record<ReportStatus, MessageKey> = {
  open: "work:status.open",
  in_progress: "work:status.in_progress",
  done: "work:status.done",
  closed: "work:status.closed",
};

/**
 * The names the server used before the vocabulary was unified with portento's.
 *
 * This build has to work against a server that hasn't been renamed yet — the
 * two ship separately, and the console is installed rather than served, so
 * there is no moment when both sides change at once. Anything arriving in the
 * old spelling is folded here; the server accepts the new one on input
 * already, so nothing has to be translated on the way out.
 *
 * Delete this once no deployment answers `pending`/`resolved` any more.
 */
const LEGACY_STATUS: Record<string, ReportStatus> = {
  pending: "open",
  resolved: "done",
};

export function normalizeStatus(s: string): ReportStatus {
  return LEGACY_STATUS[s] ?? (s as ReportStatus);
}

/**
 * Taxonomy beyond the status. The *sets* come from the server
 * (GET /reports/taxonomy) so they can't drift; only the wording lives here,
 * because a label is a UI concern and the server has no business holding it.
 */
export type ReportCategory = "bug" | "ui" | "performance" | "data" | "other";
export type ReportPriority = "low" | "medium" | "high" | "urgent";

export const CATEGORY_LABEL_KEYS: Record<ReportCategory, MessageKey> = {
  bug: "work:category.bug",
  ui: "work:category.ui",
  performance: "work:category.performance",
  data: "work:category.data",
  other: "work:category.other",
};

export const PRIORITY_LABEL_KEYS: Record<ReportPriority, MessageKey> = {
  low: "work:priority.low",
  medium: "work:priority.medium",
  high: "work:priority.high",
  urgent: "work:priority.urgent",
};

/** What GET /api/v1/reports/taxonomy answers. */
export interface ReportTaxonomy {
  categories: ReportCategory[];
  priorities: ReportPriority[];
}

export interface ReportProject {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  rateLimitPerHour: number;
  rateLimitPerReporterPerHour: number;
  isActive: boolean;
  defaultAssigneeUserId?: string;
  /** "web" enforces the Origin allowlist; "app" is for server-to-server. */
  platform: "web" | "app";
  /**
   * En qué lista aparecen los reportes que llegan por la key.
   *
   * El servidor lo manda desde siempre y la app lo ignoraba, así que no había
   * forma de ver —ni de cambiar— dónde caían. Opcional porque un proyecto puede
   * existir antes de tener bandeja.
   */
  listId?: string;
  webhookUrl: string;
  /** Whether a signing secret exists — the value itself is never returned. */
  webhookConfigured: boolean;
  createdAt: string;
  /**
   * Cuántos reportes recibió en el mes en curso. Lo único que distingue un
   * canal vivo de uno configurado y jamás usado; no cuenta el trabajo que
   * levantamos nosotros dentro de sus listas.
   */
  reportsThisMonth: number;
}

export interface CreateReportProjectResult {
  project: ReportProject;
  ingestKey: string; // shown once
}

export interface ReportListItem {
  id: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  seq: number;
  folio: string;
  title: string;
  status: ReportStatus;
  category: ReportCategory;
  priority: ReportPriority;
  area: string;
  origin: string;
  reporterName: string;
  reporterEmail: string;
  reporterId: string;
  assigneeUserId?: string;
  assigneeName?: string;
  imageCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface ReportListResult {
  items: ReportListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ReportImage {
  id: string;
  commentId?: string;
  fileName: string;
  url: string; // signed, short-lived proxy URL
  createdAt: string;
}

/**
 * Who wrote a comment, tagged by the server so the UI doesn't infer it from
 * which fields are null — that inference is what made a tenant's reply show up
 * to the reporter as their own words.
 *
 * For `tenant`, `name` is asserted by that tenant and verified by nobody: the
 * project key proves which app is speaking, not who at that app. Render it with
 * `projectName`, never alone.
 */
export interface CommentAuthor {
  kind: "user" | "reporter" | "tenant";
  name?: string;
  userId?: string;
  projectId?: string;
  projectName?: string;
  externalId?: string;
}

export interface ReportComment {
  id: string;
  kind: "user" | "system";
  author?: CommentAuthor;
  /** @deprecated superseded by `author`; still sent for older builds. */
  authorUserId?: string;
  /** @deprecated superseded by `author`. */
  authorName?: string;
  /** @deprecated superseded by `author`. */
  authorLabel?: string;
  body: string;
  images?: ReportImage[];
  createdAt: string;
  updatedAt: string;
  /**
   * Set when the comment was withdrawn. Only ever arrives in cac's own console —
   * a tenant and the reporter never receive these rows at all — so it's safe to
   * render the body next to the mark.
   */
  deletedAt?: string;
}

export interface ReportDetail {
  id: string;
  projectId: string;
  projectSlug: string;
  seq: number;
  folio: string;
  title: string;
  description: string;
  status: ReportStatus;
  category: ReportCategory;
  priority: ReportPriority;
  area: string;
  origin: string;
  url: string;
  userAgent: string;
  viewport: string;
  reporterName: string;
  reporterEmail: string;
  reporterId: string;
  assigneeUserId?: string;
  assigneeName?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  images: ReportImage[];
  comments: ReportComment[];
  telemetry?: ReportTelemetry;
}

/** transitions map from GET /api/v1/reports/transitions */
export type TransitionsMap = Record<ReportStatus, ReportStatus[]>;

/**
 * ¿Puede una tarjeta pasar de un estado a otro?
 *
 * La regla vive en el servidor —`open` y `done` no son adyacentes: se pasa por
 * `in_progress`— y llega por `fetchTransitions`. Esto sólo la consulta, para
 * que un tablero no ofrezca como destino algo que va a ser rechazado.
 *
 * Dos decisiones que parecen detalles y no lo son:
 *
 * **Sin mapa, todo vale.** Si la petición aún no volvió o falló, se deja pasar
 * y que conteste el servidor. Bloquear por no saber convertiría un fallo de red
 * en un tablero congelado, que es peor que un movimiento rechazado con su 409.
 *
 * **Quedarse donde estás siempre vale.** Reordenar dentro de una columna no es
 * una transición, y la tabla del servidor no se lista a sí misma como destino
 * — sin este caso, arrastrar una tarjeta dos posiciones más arriba quedaría
 * prohibido.
 */
export function puedeIr(
  mapa: TransitionsMap | null,
  desde: ReportStatus,
  hasta: ReportStatus,
): boolean {
  if (!mapa) return true;
  if (desde === hasta) return true;
  return (mapa[desde] ?? []).includes(hasta);
}

// ─── Telemetry (decrypted breadcrumbs, decision 7) ────────────────────────────

export interface TelemetryError {
  ts: number;
  kind: "error" | "unhandledrejection";
  message: string;
  stack?: string;
  source?: string;
}
export interface TelemetryConsole {
  ts: number;
  level: "error" | "warn";
  text: string;
}
export interface TelemetryNetwork {
  ts: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  body?: string;
}
export interface TelemetryNav {
  ts: number;
  from: string;
  to: string;
}
export interface ReportTelemetry {
  telemetry?: {
    errors?: TelemetryError[];
    console?: TelemetryConsole[];
    network?: TelemetryNetwork[];
    nav?: TelemetryNav[];
  };
  snapshot?: Record<string, unknown>;
  context?: Record<string, unknown>;
}
