import { captureContext, buildSnapshot } from "./capture";
import type { TelemetryCollector } from "./telemetry";
import type { WidgetConfig } from "./types";

const DEFAULT_ENDPOINT = "https://cac.guz-studio.dev";

export interface ReportInput {
  title: string;
  description?: string;
  reporterName?: string;
  reporterEmail?: string;
  images?: File[];
}

export interface IngestResult {
  id: string;
  seq: number;
  folio: string;
  images: number;
  token: string; // per-report reporter token (for follow-up)
}

/**
 * submit POSTs a report to the public ingest endpoint (Sentry-DSN model: the
 * write-only key rides in the client). Attaches page context, up to 5 images,
 * the telemetry breadcrumbs and the opt-in snapshot as JSON fields. Extra
 * fields the backend doesn't yet read (telemetry/snapshot/context) are simply
 * ignored server-side until the ingest extension lands — forward-compatible.
 */
export async function submit(
  cfg: WidgetConfig,
  input: ReportInput,
  telemetry?: TelemetryCollector
): Promise<IngestResult> {
  const endpoint = (cfg.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const ctx = captureContext();

  const form = new FormData();
  form.set("title", input.title);
  if (input.description) form.set("description", input.description);
  form.set("url", ctx.url);
  form.set("userAgent", ctx.userAgent);
  form.set("viewport", ctx.viewport);
  // Reporter identity from the host app's session (never asked in the form).
  let who: { id?: string; name?: string; email?: string } = {};
  if (cfg.reporter) {
    try {
      who = cfg.reporter() ?? {};
    } catch {
      /* ignore a throwing reporter callback */
    }
  }
  const name = input.reporterName ?? who.name;
  const email = input.reporterEmail ?? who.email;
  if (who.id) form.set("reporterId", who.id);
  if (name) form.set("reporterName", name);
  if (email) form.set("reporterEmail", email);

  if (telemetry) {
    try {
      form.set("telemetry", JSON.stringify(telemetry.snapshot()));
    } catch {
      /* never block a report on telemetry serialization */
    }
  }
  const snap = buildSnapshot(cfg.snapshot);
  if (snap) form.set("snapshot", JSON.stringify(snap));
  if (cfg.context) {
    try {
      form.set("context", JSON.stringify(cfg.context()));
    } catch {
      /* ignore bad user context */
    }
  }

  for (const img of (input.images ?? []).slice(0, 5)) {
    form.append("images", img);
  }

  const res = await fetch(`${endpoint}/ingest/v1/reports`, {
    method: "POST",
    headers: { "X-Ingest-Key": cfg.projectKey },
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json?.success) {
    throw new Error(json?.error ?? json?.message ?? `ingest failed (${res.status})`);
  }
  return json.data as IngestResult;
}
