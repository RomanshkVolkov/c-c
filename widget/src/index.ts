// @g-studio/report-widget — headless core + telemetry. The React component
// (`ReportWidget`) and the vanilla auto-mount fallback build on this.
export { createReporter } from "./core";
export type { Reporter } from "./core";
export { submit } from "./ingest";
export type { ReportInput, IngestResult } from "./ingest";
export type { StoredReport } from "./storage";
export { TelemetryCollector } from "./telemetry";
export type { Locale } from "./i18n";
export type {
  WidgetConfig,
  ReportCategory,
  ReportPriority,
  SnapshotConfig,
  ReporterReport,
  ReporterComment,
  ReporterImage,
  Telemetry,
  ErrorBreadcrumb,
  ConsoleBreadcrumb,
  NetworkBreadcrumb,
  NavBreadcrumb,
} from "./types";
