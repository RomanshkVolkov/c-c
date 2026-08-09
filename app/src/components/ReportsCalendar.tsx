import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReportListItem, ReportStatus } from "@/types/report";

const STATUS_DOT: Record<ReportStatus, string> = {
  open: "bg-amber-500",
  in_progress: "bg-info",
  done: "bg-emerald-500",
  closed: "bg-muted-foreground/40",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function ReportsCalendar({
  reports,
  onOpen,
}: {
  reports: ReportListItem[];
  onOpen: (id: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selected, setSelected] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, ReportListItem[]>();
    for (const r of reports) {
      const k = dayKey(new Date(r.createdAt));
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [reports]);

  // Build the 6-week grid starting on Monday.
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Mon=0
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const monthLabel = cursor.toLocaleString(undefined, { month: "long", year: "numeric" });
  const today = dayKey(new Date());
  const selectedReports = selected ? (byDay.get(selected) ?? []) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-medium capitalize">{monthLabel}</span>
        <div className="flex gap-1">
          <Button size="icon-sm" variant="outline" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCursor(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })}>
            Today
          </Button>
          <Button size="icon-sm" variant="outline" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px rounded-lg overflow-hidden border bg-border">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          const k = dayKey(d);
          const items = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === cursor.getMonth();
          return (
            <button
              key={i}
              onClick={() => items.length && setSelected(k === selected ? null : k)}
              className={`min-h-[74px] bg-background p-1.5 text-left align-top transition-colors ${
                inMonth ? "" : "opacity-40"
              } ${items.length ? "hover:bg-accent/50 cursor-pointer" : "cursor-default"} ${
                k === selected ? "ring-2 ring-primary ring-inset" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs ${k === today ? "font-bold text-primary" : "text-muted-foreground"}`}>
                  {d.getDate()}
                </span>
                {items.length > 0 && <span className="text-[0.625rem] text-muted-foreground">{items.length}</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-0.5">
                {items.slice(0, 8).map((r) => (
                  <span key={r.id} className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[r.status]}`} />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {selected && selectedReports.length > 0 && (
        <div className="rounded-lg border p-3 space-y-2">
          <p className="text-sm font-medium">
            {new Date(selectedReports[0].createdAt).toLocaleDateString()} · {selectedReports.length} report(s)
          </p>
          {selectedReports.map((r) => (
            <button
              key={r.id}
              onClick={() => onOpen(r.id)}
              className="flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent/40"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[r.status]}`} />
              <span className="font-mono text-xs text-muted-foreground">{r.folio}</span>
              <span className="truncate">{r.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
