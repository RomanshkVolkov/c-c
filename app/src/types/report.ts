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
  assigneeUserId?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  images: ReportImage[];
  comments: ReportComment[];
}

/** transitions map from GET /api/v1/reports/transitions */
export type TransitionsMap = Record<ReportStatus, ReportStatus[]>;
