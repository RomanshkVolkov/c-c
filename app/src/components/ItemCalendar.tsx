import { fecha, mesYAno } from "@/lib/fechas";
import { useT, type MessageKey } from "@/lib/i18n";
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
  /**
   * The day this sits on. Named for what it is and not for `createdAt`, which
   * is what it used to be: one caller places work by when it was raised and
   * another by when it is due, and a field that says the wrong one of those is
   * a small lie that costs somebody an hour later.
   */
  at: string;
  /** Tailwind class for the dot; the caller owns what the colours mean. */
  dotClass: string;
  /** A short prefix — a folio, a number — shown before the title. */
  label?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Cuántos caben en un día antes de resumir.
 *
 * Tres es lo que entra sin que la fila crezca de más. El resto no desaparece:
 * sale un «+N more» que abre el día entero debajo.
 */
const MAX_POR_DIA = 3;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function ItemCalendar({
  items,
  onOpen,
  countKey = "common:count.items",
}: {
  items: CalendarItem[];
  onOpen: (id: string) => void;
  /**
   * Cómo se cuentan estos elementos: «3 tarjetas», «3 reuniones».
   *
   * Antes esto era un sustantivo suelto al que la vista le pegaba «(s)». Eso
   * sólo funciona en inglés y sólo para los plurales regulares: en castellano
   * «reunión» hace «reuniones», con acento que desaparece. Ahora entra la
   * **clave del mensaje entero**, con el número dentro, y cada idioma decide
   * dónde va y qué forma toma.
   */
  countKey?: MessageKey;
}) {
  const { t } = useT();
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selected, setSelected] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const r of items) {
      const k = dayKey(new Date(r.at));
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

  const monthLabel = mesYAno(cursor);
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
          const delDia = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === cursor.getMonth();
          const visibles = delDia.slice(0, MAX_POR_DIA);
          const ocultos = delDia.length - visibles.length;
          return (
            // Una celda y no un botón: dentro va uno por elemento, y anidar
            // botones no es HTML válido — el de fuera se comería sus clics.
            <div
              key={i}
              className={`flex min-h-[104px] flex-col gap-0.5 bg-background p-1.5 align-top ${
                inMonth ? "" : "opacity-40"
              } ${k === selected ? "ring-1 ring-inset ring-primary/60" : ""}`}
            >
              <span
                className={`mb-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs ${
                  k === today
                    ? "bg-primary font-semibold text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {d.getDate()}
              </span>

              {/* El título, dentro del día.
                  Antes la celda pintaba puntos de seis píxeles y un número en la
                  esquina, y para saber **qué** había que hacer clic en el día. Un
                  calendario que no dice qué tienes ese día obliga a abrir los
                  treinta y uno para enterarse. */}
              {visibles.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                  title={r.label ? `${r.label} · ${r.title}` : r.title}
                  className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent"
                >
                  <span className={`size-1.5 shrink-0 rounded-full ${r.dotClass}`} />
                  {r.label && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{r.label}</span>
                  )}
                  <span className="truncate">{r.title}</span>
                </button>
              ))}

              {/* Lo que no cabe se dice, no se esconde: sin esto, un día con seis
                  cosas se lee como un día con tres. */}
              {ocultos > 0 && (
                <button
                  onClick={() => setSelected(k === selected ? null : k)}
                  className="rounded px-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  +{ocultos} more
                </button>
              )}
            </div>
          );
        })}
      </div>

      {selected && selectedItems.length > 0 && (
        <div className="rounded-lg border p-3 space-y-2">
          <p className="text-sm font-medium">
            {fecha(selectedItems[0].at)} ·{" "}
            {t(countKey, { count: selectedItems.length })}
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
