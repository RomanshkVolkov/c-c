import { useState } from "react";
import { CalendarDays, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import {
  claveDeDia,
  comoISO,
  desdeISO,
  inicialesDeLaSemana,
  mismoDia,
  rejillaDeMes,
} from "@/lib/mes";
import { cn } from "@/lib/utils";

/**
 * Elegir un día, sin el desplegable del sistema.
 *
 * `<input type="date">` pinta un calendario que **no es nuestro**: lo dibuja el
 * webview, no se cierra al pulsar fuera —hay que darle a Esc—, y no se puede
 * estilar ni arreglar desde aquí. Es la única razón de que este componente
 * exista; el valor que maneja sigue siendo el mismo `YYYY-MM-DD`.
 *
 * Sobre el menú desplegable que ya usa el resto de la app, que se cierra al
 * pulsar fuera y con Esc por sí solo. Traer una librería de calendarios habría
 * sido una dependencia nueva para volver a dibujar una rejilla que este proyecto
 * ya tenía escrita.
 */
export default function DatePicker({
  value,
  onChange,
  className,
  placeholder,
}: {
  /** `YYYY-MM-DD`, o vacío. El mismo contrato que el input nativo. */
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const { t } = useT();
  const elegido = value ? desdeISO(value) : null;
  const [abierto, setAbierto] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const base = elegido ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const dias = rejillaDeMes(cursor);
  const hoy = new Date();

  return (
    <DropdownMenu open={abierto} onOpenChange={setAbierto}>
      <DropdownMenuTrigger
        render={
          <button
            className={cn(
              "flex items-center gap-1.5 rounded border px-2 py-1 text-left text-sm",
              !elegido && "text-muted-foreground",
              className,
            )}
          >
            <CalendarDays className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {elegido ? fecha(elegido) : (placeholder ?? t("common:last.pickADate"))}
            </span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64 p-2">
        <div className="mb-1 flex items-center justify-between">
          <button
            className="rounded px-2 py-0.5 text-sm hover:bg-accent"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            aria-label={t("common:last.previousMonth")}
          >
            ‹
          </button>
          <span className="text-sm font-medium capitalize">
            {new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(cursor)}
          </span>
          <button
            className="rounded px-2 py-0.5 text-sm hover:bg-accent"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            aria-label={t("common:last.nextMonth")}
          >
            ›
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-muted-foreground">
          {inicialesDeLaSemana().map((d) => (
            <span key={d} className="py-1">
              {d}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {dias.map((d) => {
            // Los días de relleno se pintan apagados en vez de dejarse en blanco:
            // un hueco rompe la cuadrícula y cuesta seguir la fila con la vista.
            const deOtroMes = d.getMonth() !== cursor.getMonth();
            const esElegido = !!elegido && mismoDia(d, elegido);
            return (
              <button
                key={claveDeDia(d)}
                onClick={() => {
                  onChange(comoISO(d));
                  setAbierto(false);
                }}
                className={cn(
                  "rounded py-1 text-xs tabular-nums hover:bg-accent",
                  deOtroMes && "text-muted-foreground/40",
                  mismoDia(d, hoy) && "font-semibold text-primary",
                  esElegido && "bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>

        {/* Quitar la fecha, que con el input nativo se hacía borrando el texto a
            mano y aquí no habría forma de hacerlo. */}
        {value && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 h-6 w-full text-xs"
            onClick={() => {
              onChange("");
              setAbierto(false);
            }}
          >
            <X className="mr-1 size-3" /> {t("common:last.clearDate")}
          </Button>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
