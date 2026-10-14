import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TaskView } from "@/types/task";

/**
 * Las cuatro vistas de una lista, en un solo grupo.
 *
 * La documentación era un botón aparte con su propio icono, y eso la contaba
 * como una acción —«abrir algo»— cuando es lo mismo que el tablero: otra forma
 * de mirar la misma lista. Puesta en el grupo, volver es pulsar «Board», no
 * cerrar una ventana.
 *
 * El divisor antes de `docs` es la parte que sí la distingue: las tres primeras
 * enseñan las tarjetas, la cuarta enseña lo que se escribió sobre ellas.
 *
 * Son pestañas subrayadas en su propia fila, bajo el nombre de la lista (13-oct
 * -2026): metidas en la misma fila que el nombre, la cuenta y los filtros, en
 * una ventana normal el nombre quedaba en «t…». La fila la pone quien la usa
 * (`ListToolbar`); aquí sólo van las cuatro.
 */

export type ListView = TaskView | "docs";

const LABELS: Record<ListView, MessageKey> = {
  board: "work:board.view.board",
  list: "work:board.view.list",
  calendar: "work:board.view.calendar",
  docs: "work:board.view.docs",
};

export default function ViewSwitch({
  value,
  onChange,
}: {
  value: ListView;
  onChange: (v: ListView) => void;
}) {
  const { t } = useT();
  return (
    <div className="flex h-full items-stretch gap-4">
      {(["board", "list", "calendar", "docs"] as const).map((v) => (
        <div key={v} className="flex items-stretch gap-4">
          {v === "docs" && <span aria-hidden className="my-2.5 w-px bg-border" />}
          <button
            onClick={() => onChange(v)}
            aria-current={value === v ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 text-sm whitespace-nowrap",
              value === v
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(LABELS[v])}
          </button>
        </div>
      ))}
    </div>
  );
}
