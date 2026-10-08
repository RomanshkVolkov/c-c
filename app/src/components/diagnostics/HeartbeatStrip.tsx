import { useT } from "@/lib/i18n";
import { fechaYHora } from "@/lib/fechas";
import { duration, heartbeatStrip } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import type { TelemetryDeviceDetail } from "@/types/telemetry";

/**
 * La tira de latidos: un punto por latido y una banda roja por hueco, sobre la
 * ventana que va del primer latido guardado a ahora. Un hueco es un tramo sin
 * latir más largo que el intervalo más el margen del proyecto; el que sigue
 * abierto (el de ahora) es el que importa y va sólido.
 */
export default function HeartbeatStrip({ detail, now = Date.now() }: { detail: TelemetryDeviceDetail; now?: number }) {
  const { t } = useT();
  const beats = detail.heartbeats ?? [];
  if (beats.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("diagnostics:beats.none")}</p>;
  }
  const from = Date.parse(beats[0]);
  const marks = heartbeatStrip(beats, detail.gaps ?? [], from, now);
  const gaps = detail.gaps ?? [];
  const hb = detail.heartbeat;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t("diagnostics:beats.count", { count: beats.length })}
          {hb && <> · {t("diagnostics:beats.every", { duration: duration(hb.intervalSeconds) })}</>}
        </span>
        <span>{fechaYHora(beats[0])} → {fechaYHora(new Date(now).toISOString())}</span>
      </div>
      <div className="relative h-4 rounded bg-muted/50" role="img" aria-label={t("diagnostics:beats.title")}>
        {marks.map((m, i) =>
          m.kind === "gap" ? (
            <span
              key={i}
              data-kind="gap"
              title={t(m.open ? "diagnostics:beats.gapOpen" : "diagnostics:beats.gap", {
                duration: duration((Date.parse(m.to) - Date.parse(m.from)) / 1000),
              })}
              className={cn("absolute inset-y-0 rounded-sm", m.open ? "bg-error/60" : "bg-error/25")}
              style={{ left: `${m.left * 100}%`, width: `${Math.max(m.width * 100, 0.5)}%` }}
            />
          ) : (
            <span
              key={i}
              data-kind="beat"
              title={fechaYHora(m.from)}
              className="absolute top-1 bottom-1 w-px bg-success"
              style={{ left: `${m.left * 100}%` }}
            />
          ),
        )}
      </div>
      {!hb ? (
        <p className="text-xs text-muted-foreground">{t("diagnostics:beats.notConfigured")}</p>
      ) : (
        gaps.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {gaps.slice(-5).reverse().map((g) => (
              <li key={g.from} className={cn(g.open ? "text-error" : "text-muted-foreground")}>
                {t(g.open ? "diagnostics:beats.gapOpen" : "diagnostics:beats.gap", { duration: duration(g.seconds) })}
                {" · "}
                {fechaYHora(g.from)}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
