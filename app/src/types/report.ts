export type ReportStatus = "open" | "in_progress" | "done" | "closed";

export const REPORT_STATUSES: ReportStatus[] = [
  "open",
  "in_progress",
  "done",
  "closed",
];

export const STATUS_LABELS: Record<ReportStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  done: "Done",
  closed: "Closed",
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

export interface ReportProject {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  rateLimitPerHour: number;
  isActive: boolean;
  defaultAssigneeUserId?: string;
  createdAt: string;
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

export interface ReportComment {
  id: string;
  kind: "user" | "system";
  authorUserId?: string;
  authorName?: string;
  body: string;
  images?: ReportImage[];
  createdAt: string;
  updatedAt: string;
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
  origin: string;
  url: string;
  userAgent: string;
  viewport: string;
  reporterName: string;
  reporterEmail: string;
  reporterId: string;
  assigneeUserId?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  images: ReportImage[];
  comments: ReportComment[];
  telemetry?: ReportTelemetry;
}

/** transitions map from GET /api/v1/reports/transitions */
export type TransitionsMap = Record<ReportStatus, ReportStatus[]>;

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
