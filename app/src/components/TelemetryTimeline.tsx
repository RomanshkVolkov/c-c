import { useMemo } from "react";
import { AlertTriangle, Terminal, Wifi, Navigation, Copy } from "lucide-react";
import { toast } from "sonner";
import type { ReportTelemetry } from "@/types/report";

type Entry = {
  ts: number;
  kind: "error" | "console" | "network" | "nav";
  label: string;
  detail?: string;
  copy: string;
};

const ICON = {
  error: AlertTriangle,
  console: Terminal,
  network: Wifi,
  nav: Navigation,
} as const;

const COLOR = {
  error: "text-error",
  console: "text-warning",
  network: "text-info",
  nav: "text-muted-foreground",
} as const;

export default function TelemetryTimeline({ data }: { data: ReportTelemetry }) {
  const entries = useMemo(() => flatten(data), [data]);
  const ctx = data.context;
  const snap = data.snapshot;

  if (entries.length === 0 && !ctx && !snap) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Telemetry</h3>

      {ctx && Object.keys(ctx).length > 0 && (
        <div className="rounded-md border p-2 text-xs">
          <span className="text-muted-foreground">context</span>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono">
            {JSON.stringify(ctx, null, 2)}
          </pre>
        </div>
      )}

      {snap && Object.keys(snap).length > 0 && (
        <details className="rounded-md border p-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">snapshot</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono">
            {JSON.stringify(snap, null, 2)}
          </pre>
        </details>
      )}

      {entries.length > 0 && (
        <ol className="space-y-1.5">
          {entries.map((e, i) => {
            const Icon = ICON[e.kind];
            return (
              <li key={i} className="group flex items-start gap-2 text-xs">
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${COLOR[e.kind]}`} />
                <div className="min-w-0 flex-1">
                  <span className="break-words">{e.label}</span>
                  {e.detail && (
                    <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {e.detail}
                    </pre>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(e.copy);
                    toast.success("Copied");
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Copy entry"
                >
                  <Copy className="h-3 w-3 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Merge all breadcrumb kinds into one timestamp-ordered timeline. */
function flatten(data: ReportTelemetry): Entry[] {
  const t = data.telemetry ?? {};
  const out: Entry[] = [];

  for (const e of t.errors ?? []) {
    out.push({
      ts: e.ts,
      kind: "error",
      label: `${e.kind}: ${e.message}`,
      detail: [e.source, e.stack].filter(Boolean).join("\n") || undefined,
      copy: JSON.stringify(e),
    });
  }
  for (const c of t.console ?? []) {
    out.push({ ts: c.ts, kind: "console", label: `console.${c.level}: ${c.text}`, copy: JSON.stringify(c) });
  }
  for (const n of t.network ?? []) {
    out.push({
      ts: n.ts,
      kind: "network",
      label: `${n.method} ${n.url} → ${n.status || "network error"} (${n.durationMs}ms)`,
      detail: n.body,
      copy: JSON.stringify(n),
    });
  }
  for (const nv of t.nav ?? []) {
    out.push({ ts: nv.ts, kind: "nav", label: `nav: ${nv.from} → ${nv.to}`, copy: JSON.stringify(nv) });
  }

  return out.sort((a, b) => a.ts - b.ts);
}
