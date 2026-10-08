import { AlertCircle, CircleCheck, TriangleAlert } from "lucide-react";
import { useT } from "@/lib/i18n";
import { desde } from "@/lib/desde";
import { deviceTitle } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import type { TelemetryDeviceDetail } from "@/types/telemetry";
import HeartbeatStrip from "./HeartbeatStrip";
import KeyValueTree from "./KeyValueTree";

/**
 * La ficha de un dispositivo: arriba lo que va mal (las reglas del proyecto que
 * su último estado incumple), luego sus latidos, y el estado entero como árbol.
 * Nada de esto sabe qué app es: las reglas las escribe el proyecto.
 */
export default function DeviceSheet({ detail, error }: { detail: TelemetryDeviceDetail | null; error: string | null }) {
  const { t } = useT();
  if (error) {
    return (
      <div role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="size-3" /> {error}
      </div>
    );
  }
  if (!detail) return <p className="text-xs text-muted-foreground">{t("diagnostics:loading")}</p>;

  const alerts = detail.alerts ?? [];
  const highlight: Record<string, "warn" | "error"> = {};
  for (const a of alerts) if (!highlight[a.path] || a.severity === "error") highlight[a.path] = a.severity === "error" ? "error" : "warn";

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-base font-medium">{deviceTitle(detail)}</h2>
        <p className="text-xs text-muted-foreground">
          {[detail.subject, detail.projectName, detail.platform, detail.appVersion && `v${detail.appVersion}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground/70">{detail.deviceId}</p>
        <p className="text-xs text-muted-foreground">
          {t("diagnostics:lastSeen", { when: desde(detail.lastSeen) })} ·{" "}
          {t("diagnostics:sheet.firstSeen", { when: desde(detail.firstSeen) })}
        </p>
      </header>

      <div className="space-y-1">
        {alerts.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleCheck className="size-3.5 text-success" /> {t("diagnostics:sheet.healthy")}
          </p>
        ) : (
          <ul className="space-y-1">
            {alerts.map((a, i) => (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-1.5 rounded border px-2 py-1 text-xs",
                  a.severity === "error" ? "border-error/40 bg-error/10 text-error" : "border-warning/40 bg-warning/10 text-warning",
                )}
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="flex-1">{a.message}</span>
                <span className="font-mono opacity-70">
                  {a.path} = {JSON.stringify(a.actual)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {detail.unhealthySince && (
          <p className="text-xs text-error">{t("diagnostics:sheet.unhealthySince", { when: desde(detail.unhealthySince) })}</p>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("diagnostics:beats.title")}</h3>
        <HeartbeatStrip detail={detail} />
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("diagnostics:sheet.title")}</h3>
        {detail.device ? (
          <div className="max-h-80 overflow-auto rounded border bg-muted/20 p-2">
            <KeyValueTree value={detail.device} highlight={highlight} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("diagnostics:sheet.noSnapshot")}</p>
        )}
      </div>
    </section>
  );
}
