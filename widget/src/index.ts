// @g-studio/report-widget — headless core + telemetry. The React component
// (`ReportWidget`) and the vanilla auto-mount fallback build on this.
export { createReporter } from "./core";
export type { Reporter } from "./core";
export { submit } from "./ingest";
export type { ReportInput, IngestResult } from "./ingest";
export { TelemetryCollector } from "./telemetry";
export type {
  WidgetConfig,
  SnapshotConfig,
  Telemetry,
  ErrorBreadcrumb,
  ConsoleBreadcrumb,
  NetworkBreadcrumb,
  NavBreadcrumb,
} from "./types";
