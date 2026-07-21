export type ReportStatus = "pending" | "in_progress" | "resolved" | "closed";

export const REPORT_STATUSES: ReportStatus[] = [
  "pending",
  "in_progress",
  "resolved",
  "closed",
];

export const STATUS_LABELS: Record<ReportStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};

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
