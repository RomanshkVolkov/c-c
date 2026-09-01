import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import {
  Activity,
  RefreshCw,
  Smartphone,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTelemetryStore } from "@/store/telemetry.store";
import type { TelemetryBreadcrumb, TelemetryEventView } from "@/types/telemetry";
import NotificationCheck from "@/components/diagnostics/NotificationCheck";

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Diagnostics() {
  const { t } = useT();
  const devices = useTelemetryStore((s) => s.devices);
  const loadingDevices = useTelemetryStore((s) => s.loadingDevices);
  const error = useTelemetryStore((s) => s.error);
  const selectedDeviceId = useTelemetryStore((s) => s.selectedDeviceId);
  const timeline = useTelemetryStore((s) => s.timeline);
  const loadingTimeline = useTelemetryStore((s) => s.loadingTimeline);
  const fetchDevices = useTelemetryStore((s) => s.fetchDevices);
  const selectDevice = useTelemetryStore((s) => s.selectDevice);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  return (
    <div className="flex-1 flex min-h-0">
      {/* Devices */}
      <aside className="w-80 shrink-0 border-r flex flex-col bg-muted/10">
        <header className="h-12 flex items-center justify-between px-3 border-b shrink-0">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Activity className="size-4" /> Diagnostics
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            title={t("common:last.refresh")}
            disabled={loadingDevices}
            onClick={() => void fetchDevices()}
          >
            <RefreshCw className={cn("size-3", loadingDevices && "animate-spin")} />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2 space-y-1.5">
          {error ? (
            <div className="px-2 py-2 text-xs text-destructive flex items-center gap-1.5">
              <AlertCircle className="size-3" /> {error}
            </div>
          ) : loadingDevices && devices.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("common:last.noTelemetry")}
            </p>
          ) : (
            devices.map((d) => (
              <button
                key={`${d.deviceId}:${d.projectId}`}
                onClick={() => void selectDevice(d.deviceId)}
                className={cn(
                  "w-full rounded-md border p-2 text-left transition-colors hover:bg-accent",
                  selectedDeviceId === d.deviceId && "border-primary bg-accent",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate font-mono text-xs">{d.deviceId}</span>
                  {d.errorCount > 0 && (
                    <Badge variant="destructive" className="h-4 px-1 text-xs">
                      {d.errorCount}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate">{d.projectName}</span>
                  <span>·</span>
                  <span>{d.platform || "?"}</span>
                  {d.appVersion && <span>· v{d.appVersion}</span>}
                </div>
                <div className="mt-0.5 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{d.batches} batches · {d.reqCount} req</span>
                  <span>{relativeTime(d.lastSeen)}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Timeline */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="shrink-0 border-b px-4 py-2">
          <NotificationCheck />
        </div>
        {!selectedDeviceId ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Select a device to see its request / error timeline.
            </p>
          </div>
        ) : loadingTimeline && timeline.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading timeline…
          </div>
        ) : timeline.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">{t("common:last.noEvents")}</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4 space-y-3 max-w-4xl w-full mx-auto">
            <h2 className="font-mono text-sm">{selectedDeviceId}</h2>
            {timeline.map((batch) => (
              <BatchCard key={batch.id} batch={batch} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchCard({ batch }: { batch: TelemetryEventView }) {
  const { t } = useT();
  const [showDevice, setShowDevice] = useState(false);
  const [showBeats, setShowBeats] = useState(false);

  // Heartbeats are a continuous liveness signal (a gap in them means tracking
  // died). Useful in aggregate, noise in a timeline — collapse them by default.
  const all = batch.breadcrumbs ?? [];
  const beats = all.filter((c) => c.type === "heartbeat").length;
  const crumbs = showBeats ? all : all.filter((c) => c.type !== "heartbeat");
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {fechaYHora(batch.receivedAt)}
        </span>
        <span className="text-muted-foreground">· {relativeTime(batch.receivedAt)}</span>
        <span className="ml-auto flex items-center gap-2">
          <Badge variant="secondary" className="h-4 px-1 text-xs">
            {batch.reqCount} req
          </Badge>
          {batch.errorCount > 0 && (
            <Badge variant="destructive" className="h-4 px-1 text-xs">
              {batch.errorCount} err
            </Badge>
          )}
        </span>
      </div>

      {batch.device && (
        <div className="border-b">
          <button
            className="flex w-full items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:bg-accent/50"
            onClick={() => setShowDevice((v) => !v)}
          >
            {showDevice ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("common:last.deviceContext")}
          </button>
          {showDevice && (
            <pre className="max-h-56 overflow-auto bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(batch.device, null, 2)}
            </pre>
          )}
        </div>
      )}

      {beats > 0 && (
        <button
          className="w-full border-b px-3 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50"
          onClick={() => setShowBeats((v) => !v)}
        >
          {t(showBeats ? "common:count.hide" : "common:count.show")}{" "}
          {t("common:count.heartbeats", { count: beats })}
        </button>
      )}
      <ul className="divide-y">
        {crumbs.map((c, i) => (
          <CrumbRow key={i} crumb={c} />
        ))}
      </ul>
    </div>
  );
}

function statusColor(status?: number): string {
  if (status === undefined) return "text-muted-foreground";
  if (status === 0 || status >= 500) return "text-error";
  if (status >= 400) return "text-warning";
  return "text-success";
}

function CrumbRow({ crumb }: { crumb: TelemetryBreadcrumb }) {
  const [open, setOpen] = useState(false);
  const isError = crumb.type === "error" || crumb.level === "error";
  const isNetwork = crumb.type === "network";

  return (
    <li className="px-3 py-1.5 text-xs">
      <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <span
          className={cn(
            "mt-1 size-1.5 shrink-0 rounded-full",
            isError ? "bg-error" : isNetwork ? "bg-info" : "bg-muted-foreground",
          )}
        />
        <span className="flex-1 min-w-0">
          {isNetwork ? (
            <span className="flex items-center gap-1.5">
              <span className="font-medium">{String(crumb.method ?? "")}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {String(crumb.url ?? "")}
              </span>
              {crumb.status !== undefined && (
                <span className={cn("ml-auto font-mono", statusColor(crumb.status))}>
                  {crumb.status}
                </span>
              )}
            </span>
          ) : (
            <span className={cn(isError && "text-destructive")}>
              {crumb.message || crumb.name || crumb.eventName || crumb.type || "event"}
            </span>
          )}
          {(crumb.eventName || crumb.category) && (
            <span className="ml-1 text-xs text-muted-foreground">
              {crumb.category}/{crumb.eventName}
            </span>
          )}
        </span>
      </button>
      {open && (
        <pre className="mt-1 ml-3.5 max-h-56 overflow-auto rounded bg-muted/40 px-2 py-1.5 text-xs whitespace-pre-wrap break-all">
          {JSON.stringify(crumb, null, 2)}
        </pre>
      )}
    </li>
  );
}
