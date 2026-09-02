import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
 */

export type ListView = "board" | "list" | "calendar" | "docs";

const ROTULOS: Record<ListView, MessageKey> = {
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
    <div className="ml-2 flex items-center rounded-md border p-0.5">
      {(["board", "list", "calendar", "docs"] as const).map((v) => (
        <div key={v} className="flex items-center">
          {v === "docs" && <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />}
          <button
            onClick={() => onChange(v)}
            className={cn(
              "rounded px-2 py-0.5 text-xs",
              value === v ? "bg-accent text-foreground" : "text-muted-foreground",
            )}
          >
            {t(ROTULOS[v])}
          </button>
        </div>
      ))}
    </div>
  );
}
