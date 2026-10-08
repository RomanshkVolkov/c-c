import { useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import Picker from "@/components/ui/picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { fechaYHora } from "@/lib/fechas";
import { crumbFields, crumbTitle, crumbTypes, flattenTimeline, matchesText, shortId, type TimelineRow } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import { useTelemetryStore } from "@/store/telemetry.store";
import type { Severity } from "@/types/telemetry";
import KeyValueTree from "./KeyValueTree";

/**
 * El timeline de un dispositivo, plano: un evento por fila, ordenados por su
 * hora y no por el lote en que llegaron, con la gravedad que decide el backend
 * en color, y una raya donde empieza otra sesión. Los latidos van como un
 * evento más, con su contenido al abrirlos.
 */
export default function Timeline() {
  const { t } = useT();
  const batches = useTelemetryStore((s) => s.timeline);
  const loading = useTelemetryStore((s) => s.loadingTimeline);
  const error = useTelemetryStore((s) => s.timelineError);
  const before = useTelemetryStore((s) => s.timelineBefore);
  const filters = useTelemetryStore((s) => s.filters);
  const setFilters = useTelemetryStore((s) => s.setFilters);
  const loadMore = useTelemetryStore((s) => s.loadMoreTimeline);

  const rows = useMemo(() => flattenTimeline(batches), [batches]);
  const visible = useMemo(() => rows.filter((r) => matchesText(r, filters.text)), [rows, filters.text]);
  // Los tipos que se ofrecen: los que han salido, más los que estén elegidos
  // aunque el filtro los haya hecho desaparecer.
  const types = useMemo(() => [...new Set([...crumbTypes(batches), ...filters.types])].sort(), [batches, filters.types]);
  const broken = batches.filter((b) => b.undecryptable).length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filters.text}
          onChange={(e) => void setFilters({ text: e.target.value })}
          placeholder={t("diagnostics:timeline.filterText")}
          aria-label={t("diagnostics:timeline.filterText")}
          className="h-8 w-48 text-xs"
        />
        <Picker
          size="sm"
          aria-label={t("diagnostics:timeline.severity")}
          value={filters.minSeverity}
          onChange={(v) => void setFilters({ minSeverity: v as Severity })}
          options={[
            { value: "info", label: t("diagnostics:timeline.all") },
            { value: "warn", label: t("diagnostics:timeline.warnUp") },
            { value: "error", label: t("diagnostics:timeline.errorOnly") },
          ]}
        />
        <Picker
          size="sm"
          aria-label={t("diagnostics:timeline.types")}
          value={filters.types[0] ?? ""}
          onChange={(v) => void setFilters({ types: v ? [v] : [] })}
          placeholder={t("diagnostics:timeline.allTypes")}
          options={[{ value: "", label: t("diagnostics:timeline.allTypes") }, ...types.map((ty) => ({ value: ty, label: ty }))]}
        />
        <Picker
          size="sm"
          aria-label={t("diagnostics:timeline.since")}
          value={String(filters.sinceHours)}
          onChange={(v) => void setFilters({ sinceHours: Number(v) })}
          options={[
            { value: "0", label: t("diagnostics:timeline.always") },
            ...[1, 6, 24, 72].map((h) => ({ value: String(h), label: t("diagnostics:timeline.lastHours", { count: h }) })),
          ]}
        />
        {filters.sessionId && (
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void setFilters({ sessionId: "" })}>
            {t("diagnostics:timeline.clearSession")} · {shortId(filters.sessionId)}
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3" /> {error}
        </div>
      )}
      {broken > 0 && <p className="text-xs text-warning">{t("diagnostics:timeline.undecryptable")}</p>}

      {loading && batches.length === 0 ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {t("diagnostics:loading")}
        </p>
      ) : visible.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground">{t("diagnostics:timeline.empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {visible.map((r) => (
            <Row key={r.key} row={r} onSession={(id) => void setFilters({ sessionId: id })} />
          ))}
        </ul>
      )}

      {before && (
        <Button size="sm" variant="ghost" className="w-full text-xs" disabled={loading} onClick={() => void loadMore()}>
          {t("diagnostics:loadMore")}
        </Button>
      )}
    </section>
  );
}

const DOT: Record<Severity, string> = { error: "bg-error", warn: "bg-warning", info: "bg-muted-foreground/50" };
const TEXT: Record<Severity, string> = { error: "text-error", warn: "text-warning", info: "" };

function Row({ row, onSession }: { row: TimelineRow; onSession: (id: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { crumb, severity } = row;
  const fields = crumbFields(crumb);
  return (
    <li data-severity={severity}>
      {row.sessionStart && (
        <button
          type="button"
          onClick={() => onSession(row.sessionId)}
          className="block w-full border-b border-dashed bg-muted/30 px-3 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
          title={t("diagnostics:timeline.sessionFilter")}
        >
          {t("diagnostics:timeline.newSession", { id: shortId(row.sessionId || "—") })}
        </button>
      )}
      <button type="button" className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/40" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", DOT[severity])} />
        <time className="shrink-0 tabular-nums text-muted-foreground" dateTime={new Date(row.at).toISOString()}>
          {fechaYHora(row.at)}
        </time>
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{crumb.type ?? "?"}</span>
        <span className={cn("min-w-0 flex-1 truncate", TEXT[severity])}>{crumbTitle(crumb)}</span>
        {typeof crumb.status === "number" && (
          <span className={cn("shrink-0 font-mono", crumb.status === 0 || crumb.status >= 400 ? "text-error" : "text-success")}>
            {crumb.status}
          </span>
        )}
        {severity !== "info" && <span className={cn("shrink-0", TEXT[severity])}>{t(`diagnostics:severity.${severity}`)}</span>}
      </button>
      {open && (
        <div className="ml-6 mr-3 mb-2 rounded bg-muted/30 p-2">
          {fields.length > 0 ? <KeyValueTree value={Object.fromEntries(fields)} depthOpen={2} /> : <KeyValueTree value={crumb} />}
        </div>
      )}
    </li>
  );
}
