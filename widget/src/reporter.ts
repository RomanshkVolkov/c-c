// Reporter follow-up API — view a report and reply, authorized by the per-report
// token (no email/login). Cross-origin; the token is the auth.
import type { ReporterReport, WidgetConfig } from "./types";

const DEFAULT_ENDPOINT = "https://cac.guz-studio.dev";

function base(cfg: WidgetConfig): string {
  return (cfg.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
}

// The backend returns relative image proxy URLs (/api/v1/...). The console
// resolves those against its own origin, but the widget lives on the client's
// site, so they must be absolutized against the ingest endpoint or the <img>
// 404s. Applied to the report gallery and every comment's images.
function absolutizeImages(cfg: WidgetConfig, report: ReporterReport): ReporterReport {
  const b = base(cfg);
  const fix = (u: string) => (u.startsWith("/") ? b + u : u);
  report.images = (report.images ?? []).map((i) => ({ ...i, url: fix(i.url) }));
  report.comments = (report.comments ?? []).map((c) => ({
    ...c,
    images: (c.images ?? []).map((i) => ({ ...i, url: fix(i.url) })),
  }));
  return report;
}

export async function fetchReporterView(
  cfg: WidgetConfig,
  id: string,
  token: string
): Promise<ReporterReport> {
  const res = await fetch(`${base(cfg)}/ingest/v1/reports/${id}?token=${encodeURIComponent(token)}`);
  const json = await res.json();
  if (!res.ok || !json?.success) throw new Error(json?.error ?? `failed (${res.status})`);
  return absolutizeImages(cfg, json.data as ReporterReport);
}

export async function fetchUnreadCounts(
  cfg: WidgetConfig,
  items: { id: string; token: string; since: number }[]
): Promise<Record<string, number>> {
  if (items.length === 0) return {};
  const res = await fetch(`${base(cfg)}/ingest/v1/reports/unread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const json = await res.json();
  if (!res.ok || !json?.success) return {};
  return (json.data ?? {}) as Record<string, number>;
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
  return absolutizeImages(cfg, json.data as ReporterReport);
}
