import { submit, type ReportInput, type IngestResult } from "./ingest";
import { TelemetryCollector } from "./telemetry";
import type { WidgetConfig } from "./types";

export interface Reporter {
  /** send a report; page context + telemetry + snapshot are attached automatically */
  submit(input: ReportInput): Promise<IngestResult>;
  /** current telemetry snapshot (for a "what will be sent" preview) */
  telemetry(): ReturnType<TelemetryCollector["snapshot"]>;
  /** stop collecting and restore all patched globals */
  destroy(): void;
}

/**
 * createReporter installs the passive telemetry collectors immediately and
 * returns a handle to submit reports. This is the headless core shared by the
 * React component and the vanilla fallback.
 */
export function createReporter(cfg: WidgetConfig): Reporter {
  if (!cfg.projectKey) throw new Error("report-widget: projectKey is required");

  const collector = new TelemetryCollector(cfg);
  collector.install();

  return {
    submit: (input) => submit(cfg, input, collector),
    telemetry: () => collector.snapshot(),
    destroy: () => collector.uninstall(),
  };
}
