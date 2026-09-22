import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";

import { fecha, mesYAno } from "@/lib/fechas";
import {
  dayKey,
  toISODate,
  fromISODate,
  weekdayInitials,
  monthGrid,
} from "@/lib/month";
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
export interface CalendarEntry {
  id: string;
  title: string;
  /** Tailwind class for the dot; the caller owns what the colours mean. */
  dotClass: string;
  /** A short prefix — a folio, a number — shown before the title. */
  label?: string;
}

/**
 * An entry placed on a day, saying **which kind** of date it carries.
 *
 * Una sola `at` para todo es lo que torció el calendario de «Mi trabajo»: un
 * vencimiento es una **fecha** (el día a medianoche UTC) y una reunión es un
 * **instante**, y leídos igual uno de los dos sale mal. Con captadores locales,
 * el vencimiento del 30 se pinta el 29 al oeste de Greenwich; con captadores
 * UTC, la reunión de las 20:00 del 29 en Querétaro se pinta el 30. Las dos
 * lecturas son correctas para datos distintos, y este componente no puede
 * adivinar cuál le dan — así que el tipo obliga al llamante a decirlo.
 *
 * - `day`: `YYYY-MM-DD`, un día sin hora ni zona. Nunca pasa por `new Date()`.
 * - `at`: RFC3339, un momento concreto; cae en el día **local** de quien mira.
 */
export type CalendarItem = CalendarEntry &
  ({ day: string; at?: never } | { at: string; day?: never });

/** El día local en que se pinta, según qué clase de fecha lleve. */
function localDayOf(item: CalendarItem): Date | null {
  if (item.day !== undefined) return fromISODate(item.day);
  const d = new Date(item.at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Cuántos caben en un día antes de resumir.
 *
 * Tres es lo que entra sin que la fila crezca de más. El resto no desaparece:
 * sale un «+N more» que abre el día entero debajo.
 */
const MAX_PER_DAY = 3;

export default function ItemCalendar({
  items,
  undated = [],
  onSchedule,
  onOpen,
  countKey = "common:count.items",
}: {
  items: CalendarItem[];
  /**
   * Lo que no tiene fecha, y por tanto no cabe en ningún día.
   *
   * Va debajo del mes en vez de descartarse. Descartarlo en silencio es lo que
   * hacía esta vista: de sesenta y cinco tareas se veía **una**, mientras la
   * cabecera seguía diciendo sesenta y cinco. Un calendario que esconde el 98%
   * de lo que hay no está filtrando, está mintiendo.
   */
  undated?: CalendarEntry[];
  /**
   * Poner fecha arrastrando una tarjeta de la tira a un día.
   *
   * Sin esto la tira sería una lista de reproches: «aquí tienes lo que no puedo
   * enseñarte». Con esto el calendario deja de ser algo que se mira y pasa a ser
   * donde se planifica, que es lo que le faltaba para servir de algo.
   *
   * Opcional: el calendario del tablero coloca por fecha de creación, y ésa no
   * se cambia arrastrando nada.
   */
  onSchedule?: (id: string, iso: string) => void;
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
  const [dragging, setDragging] = useState<string | null>(null);
  // Los mismos sensores que el tablero: puntero **y teclado**. El arrastre HTML5
  // nativo no tiene lo segundo, y esta es la única forma de poner una fecha sin
  // abrir la tarjeta — dejarla fuera del teclado la haría inalcanzable para
  // quien no usa ratón.
  const sensors = useSensors(
    // Ocho píxeles antes de considerarlo arrastre: sin el umbral, un clic con la
    // mano poco firme mueve la tarjeta en vez de abrirla.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const r of items) {
      const d = localDayOf(r);
      if (!d) continue;
      const k = dayKey(d);
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [items]);

  // La rejilla vive en `lib/month`: la usan este calendario y el selector de
  // fecha, y es aritmética llena de bordes que se prueba mejor sola.
  const cells = useMemo(() => monthGrid(cursor), [cursor]);

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

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setDragging(String(e.active.id))}
        onDragEnd={(e) => {
          setDragging(null);
          // `over` es el día sobre el que se soltó; su id **es** la fecha.
          if (onSchedule && e.over) onSchedule(String(e.active.id), String(e.over.id));
        }}
        onDragCancel={() => setDragging(null)}
      >
      <div className="grid grid-cols-7 gap-px rounded-lg overflow-hidden border bg-border">
        {weekdayInitials().map((w) => (
          <div key={w} className="bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          const k = dayKey(d);
          const dayItems = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === cursor.getMonth();
          const shown = dayItems.slice(0, MAX_PER_DAY);
          const hidden = dayItems.length - shown.length;
          return (
            // Una celda y no un botón: dentro va uno por elemento, y anidar
            // botones no es HTML válido — el de fuera se comería sus clics.
            <DayCell
              key={i}
              iso={toISODate(d)}
              acceptsDrop={!!onSchedule && dragging !== null}
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
              {shown.map((r) => (
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
              {hidden > 0 && (
                <button
                  onClick={() => setSelected(k === selected ? null : k)}
                  className="rounded px-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  +{hidden} more
                </button>
              )}
            </DayCell>
          );
        })}
      </div>

      {/* Lo que no tiene fecha, debajo y a mano. Ver el comentario de `undated`. */}
      {undated.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {onSchedule
              ? t("common:calendar.undatedDrag", { count: undated.length })
              : t("common:calendar.undated", { count: undated.length })}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {undated.map((r) => (
              <UndatedChip
                key={r.id}
                item={r}
                draggable={!!onSchedule}
                onOpen={() => onOpen(r.id)}
              />
            ))}
          </div>
        </div>
      )}
      </DndContext>

      {selected && selectedItems.length > 0 && (
        <div className="rounded-lg border p-3 space-y-2">
          <p className="text-sm font-medium">
            {fecha(localDayOf(selectedItems[0]))} ·{" "}
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

/** Un día del mes, que además puede recibir una tarjeta soltada encima. */
function DayCell({
  iso,
  acceptsDrop,
  className,
  children,
}: {
  iso: string;
  acceptsDrop: boolean;
  className: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: iso, disabled: !acceptsDrop });
  return (
    <div
      ref={setNodeRef}
      className={`${className} ${isOver ? "ring-1 ring-inset ring-primary" : ""}`}
    >
      {children}
    </div>
  );
}

/**
 * Una tarjeta sin fecha, de la tira de abajo.
 *
 * El asa es aparte del título: el título abre y el asa arrastra. Con todo el
 * bloque arrastrable, abrir una tarjeta se convierte en una apuesta sobre si la
 * mano se movió tres píxeles.
 */
function UndatedChip({
  item,
  draggable,
  onOpen,
}: {
  item: CalendarEntry;
  draggable: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
    disabled: !draggable,
  });
  return (
    <span
      ref={setNodeRef}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={`flex max-w-64 items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] ${
        isDragging ? "z-50 opacity-80 shadow-lg" : ""
      }`}
    >
      {draggable && (
        <button
          {...listeners}
          {...attributes}
          className="shrink-0 cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3" />
        </button>
      )}
      <span className={`size-1.5 shrink-0 rounded-full ${item.dotClass}`} />
      <button onClick={onOpen} className="flex min-w-0 items-center gap-1 text-left">
        {item.label && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{item.label}</span>
        )}
        <span className="truncate">{item.title}</span>
      </button>
    </span>
  );
}
