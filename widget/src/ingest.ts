import { captureContext, buildSnapshot } from "./capture";
import type { TelemetryCollector } from "./telemetry";
import type { ReportCategory, ReportPriority, WidgetConfig } from "./types";

const DEFAULT_ENDPOINT = "https://cac.guz-studio.dev";

export interface ReportInput {
  title: string;
  description?: string;
  reporterName?: string;
  reporterEmail?: string;
  /**
   * What kind of problem this is. Worth asking the person filing it — they're
   * the only one who knows — and it's what makes triage possible later.
   * Anything the server doesn't recognise is filed as "other" rather than
   * rejected, so an outdated widget never loses a report.
   */
  category?: ReportCategory;
  /**
   * Deliberately NOT asked of the reporter: everyone marks their own problem
   * urgent. It's here for automated callers that genuinely know (a failed sync
   * is not a cosmetic issue); a human form should leave it out and let triage
   * decide.
   */
  priority?: ReportPriority;
  /** Which part of the product this belongs to. Free text — see defaultArea. */
  area?: string;
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
  if (input.category) form.set("category", input.category);
  if (input.priority) form.set("priority", input.priority);
  const area = input.area ?? cfg.defaultArea;
  if (area) form.set("area", area);
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
