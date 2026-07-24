export interface TelemetryDeviceSummary {
  deviceId: string;
  projectId: string;
  projectName: string;
  platform: string;
  appVersion: string;
  batches: number;
  reqCount: number;
  errorCount: number;
  lastSeen: string;
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
  receivedAt: string;
  device: Record<string, unknown> | null;
  breadcrumbs: TelemetryBreadcrumb[] | null;
}
