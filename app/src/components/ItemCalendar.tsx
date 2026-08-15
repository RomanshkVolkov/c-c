import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A month of work, by the day it arrived.
 *
 * Deliberately not typed to reports any more. It groups by a date and paints a
 * dot per item, which is true of a board card as much as it was of a report —
 * the view was only ever tied to reports because that was the page it lived on.
 * The caller says what colour each dot is, so the board can colour by column
 * without this file knowing what a column is.
 */
export interface CalendarItem {
  id: string;
  title: string;
  createdAt: string;
  /** Tailwind class for the dot; the caller owns what the colours mean. */
  dotClass: string;
  /** A short prefix — a folio, a number — shown before the title. */
  label?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function ItemCalendar({
  items,
  onOpen,
  noun = "item",
}: {
  items: CalendarItem[];
  onOpen: (id: string) => void;
  /** What one of these is called, for "3 report(s)" vs "3 card(s)". */
  noun?: string;
}) {
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selected, setSelected] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const r of items) {
      const k = dayKey(new Date(r.createdAt));
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [items]);

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
  const selectedItems = selected ? (byDay.get(selected) ?? []) : [];

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
                {items.length > 0 && <span className="text-xs text-muted-foreground">{items.length}</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-0.5">
                {items.slice(0, 8).map((r) => (
                  <span key={r.id} className={`h-1.5 w-1.5 rounded-full ${r.dotClass}`} />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {selected && selectedItems.length > 0 && (
        <div className="rounded-lg border p-3 space-y-2">
          <p className="text-sm font-medium">
            {new Date(selectedItems[0].createdAt).toLocaleDateString()} · {selectedItems.length}{" "}
            {noun}(s)
          </p>
          {selectedItems.map((r) => (
            <button
              key={r.id}
              onClick={() => onOpen(r.id)}
              className="flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent/40"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${r.dotClass}`} />
              {r.label && <span className="font-mono text-xs text-muted-foreground">{r.label}</span>}
              <span className="truncate">{r.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
