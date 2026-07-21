// Reporter follow-up API — view a report and reply, authorized by the per-report
// token (no email/login). Cross-origin; the token is the auth.
import type { ReporterReport, WidgetConfig } from "./types";

const DEFAULT_ENDPOINT = "https://cac.guz-studio.dev";

function base(cfg: WidgetConfig): string {
  return (cfg.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export async function fetchReporterView(
  cfg: WidgetConfig,
  id: string,
  token: string
): Promise<ReporterReport> {
  const res = await fetch(`${base(cfg)}/ingest/v1/reports/${id}?token=${encodeURIComponent(token)}`);
  const json = await res.json();
  if (!res.ok || !json?.success) throw new Error(json?.error ?? `failed (${res.status})`);
  return json.data as ReporterReport;
}

export async function postReporterReply(
  cfg: WidgetConfig,
  id: string,
  token: string,
  body: string,
  images: File[] = []
): Promise<ReporterReport> {
  const form = new FormData();
  form.set("body", body);
  for (const f of images.slice(0, 5)) form.append("images", f);
  const res = await fetch(`${base(cfg)}/ingest/v1/reports/${id}/comments?token=${encodeURIComponent(token)}`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json?.success) throw new Error(json?.error ?? `failed (${res.status})`);
  return json.data as ReporterReport;
}
