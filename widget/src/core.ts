import { submit, type ReportInput, type IngestResult } from "./ingest";
import { fetchReporterView, fetchUnreadCounts, postReporterReply } from "./reporter";
import { loadReports, saveReport, markSeen, type StoredReport } from "./storage";
import { TelemetryCollector } from "./telemetry";
import type { ReporterReport, WidgetConfig } from "./types";

export interface Reporter {
  /** send a report; page context + telemetry + identity are attached automatically */
  submit(input: ReportInput): Promise<IngestResult>;
  /** current telemetry snapshot (for a "what will be sent" preview) */
  telemetry(): ReturnType<TelemetryCollector["snapshot"]>;
  /** reports this browser has filed (from stored per-report tokens) */
  myReports(): StoredReport[];
  /** the reporter's own view of one of their reports (status + thread) */
  viewReport(id: string): Promise<ReporterReport>;
  /** reply to one of the reporter's reports */
  reply(id: string, body: string, images?: File[]): Promise<ReporterReport>;
  /** total unread team replies across stored reports (one batched request) */
  unreadCount(): Promise<number>;
  /** mark a report's thread as seen (resets its unread count) */
  markSeen(id: string): void;
  /** stop collecting and restore all patched globals */
  destroy(): void;
}

/**
 * createReporter installs the passive telemetry collectors immediately and
 * returns a handle to submit reports and follow up on them. Headless core
 * shared by the React component and the vanilla fallback.
 */
export function createReporter(cfg: WidgetConfig): Reporter {
  if (!cfg.projectKey) throw new Error("report-widget: projectKey is required");

  const collector = new TelemetryCollector(cfg);
  collector.install();

  const tokenFor = (id: string): string => {
    const r = loadReports(cfg.projectKey).find((x) => x.id === id);
    if (!r) throw new Error("report-widget: no token for this report");
    return r.token;
  };

  return {
    submit: async (input) => {
      const res = await submit(cfg, input, collector);
      if (res.token) {
        saveReport(cfg.projectKey, {
          id: res.id,
          folio: res.folio,
          title: input.title,
          token: res.token,
          createdAt: Date.now(),
        });
      }
      return res;
    },
    telemetry: () => collector.snapshot(),
    myReports: () => loadReports(cfg.projectKey),
    viewReport: (id) => fetchReporterView(cfg, id, tokenFor(id)),
    reply: (id, body, images) => postReporterReply(cfg, id, tokenFor(id), body, images),
    unreadCount: async () => {
      const items = loadReports(cfg.projectKey).map((r) => ({
        id: r.id,
        token: r.token,
        since: r.lastSeenAt ?? Math.floor(r.createdAt / 1000),
      }));
      const counts = await fetchUnreadCounts(cfg, items);
      return Object.values(counts).reduce((a, b) => a + b, 0);
    },
    markSeen: (id) => markSeen(cfg.projectKey, id),
    destroy: () => collector.uninstall(),
  };
}
