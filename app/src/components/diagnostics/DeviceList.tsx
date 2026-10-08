import { useEffect, useState } from "react";
import { AlertCircle, Search, Smartphone, TriangleAlert, ZapOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { desde } from "@/lib/desde";
import { deviceTitle } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import { useTelemetryStore } from "@/store/telemetry.store";
import type { TelemetryDeviceSummary } from "@/types/telemetry";

/**
 * La lista de dispositivos: cómo se llama cada uno, de quién es, cuándo se le
 * vio y si algo va mal. Se busca en el servidor (nombre, persona o id) y se
 * pagina, porque una flota pasa de las doscientas filas que había de tope.
 */
export default function DeviceList() {
  const { t } = useT();
  const devices = useTelemetryStore((s) => s.devices);
  const cursor = useTelemetryStore((s) => s.devicesCursor);
  const loading = useTelemetryStore((s) => s.loadingDevices);
  const error = useTelemetryStore((s) => s.error);
  const query = useTelemetryStore((s) => s.query);
  const selected = useTelemetryStore((s) => s.selected);
  const fetchDevices = useTelemetryStore((s) => s.fetchDevices);
  const setQuery = useTelemetryStore((s) => s.setQuery);
  const select = useTelemetryStore((s) => s.select);
  const [text, setText] = useState(query);

  // Al teclear, se espera a que se pare: una petición por letra sería pedir la
  // lista entera diez veces para escribir un nombre.
  useEffect(() => {
    if (text === query) return;
    const id = setTimeout(() => void setQuery(text), 250);
    return () => clearTimeout(id);
  }, [text, query, setQuery]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 border-b p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("diagnostics:search")}
          aria-label={t("diagnostics:search")}
          className="h-8 pl-7 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && (
          <div role="alert" className="flex items-center gap-1.5 px-2 py-2 text-xs text-destructive">
            <AlertCircle className="size-3 shrink-0" /> {error}
          </div>
        )}
        {!error && loading && devices.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("diagnostics:loading")}</p>
        )}
        {!error && !loading && devices.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {query.trim() ? t("diagnostics:noMatches") : t("diagnostics:noDevices")}
          </p>
        )}
        {devices.map((d) => (
          <DeviceRow
            key={`${d.projectId}:${d.deviceId}`}
            device={d}
            active={selected?.projectId === d.projectId && selected?.deviceId === d.deviceId}
            onPick={() => void select({ projectId: d.projectId, deviceId: d.deviceId })}
          />
        ))}
        {cursor && (
          <Button size="sm" variant="ghost" className="w-full text-xs" disabled={loading} onClick={() => void fetchDevices(true)}>
            {t("diagnostics:loadMore")}
          </Button>
        )}
      </div>
    </div>
  );
}

function DeviceRow({ device: d, active, onPick }: { device: TelemetryDeviceSummary; active: boolean; onPick: () => void }) {
  const { t } = useT();
  const alerts = d.alerts ?? [];
  const worst = alerts.some((a) => a.severity === "error") ? "error" : alerts.length ? "warn" : null;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={cn(
        "w-full rounded-md border p-2 text-left transition-colors hover:bg-accent",
        active && "border-primary bg-accent",
        worst === "error" && "border-error/50",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("flex-1 truncate text-sm", !d.label && "font-mono text-xs")}>{deviceTitle(d)}</span>
        {d.silentSince && <ZapOff aria-label={t("diagnostics:silentSince", { when: desde(d.silentSince) })} className="size-3.5 text-error" />}
        {worst && (
          <TriangleAlert
            aria-label={alerts.map((a) => a.message).join(" · ")}
            className={cn("size-3.5", worst === "error" ? "text-error" : "text-warning")}
          />
        )}
      </div>
      {d.subject && <div className="mt-0.5 truncate text-xs">{d.subject}</div>}
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{d.projectName}</span>
        <span>·</span>
        <span>{d.platform || "?"}</span>
        {d.appVersion && <span className="truncate">· v{d.appVersion}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        {d.errorCount > 0 && (
          <Badge variant="destructive" className="h-4 px-1 text-xs">
            {t("diagnostics:errors", { count: d.errorCount })}
          </Badge>
        )}
        {(d.warnCount ?? 0) > 0 && (
          <Badge variant="outline" className="h-4 border-warning/50 px-1 text-xs text-warning">
            {t("diagnostics:warnings", { count: d.warnCount ?? 0 })}
          </Badge>
        )}
        <span className="ml-auto">{t("diagnostics:lastSeen", { when: desde(d.lastSeen) })}</span>
      </div>
      {alerts.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {alerts.slice(0, 3).map((a, i) => (
            <li key={i} className={a.severity === "error" ? "text-error" : "text-warning"}>
              {a.message}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}
