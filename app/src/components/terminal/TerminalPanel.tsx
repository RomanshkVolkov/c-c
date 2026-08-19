import { useCallback, useRef } from "react";
import { Maximize2, Minimize2, TerminalSquare, X } from "lucide-react";
import { useTerminals } from "@/store/terminal.store";
import TerminalView from "./TerminalView";
import { cn } from "@/lib/utils";

/**
 * El cajón de terminales: barra de pestañas arriba y un xterm debajo.
 *
 * Las pestañas que no se miran se esconden con `display:none` y **no se
 * desmontan**. Es la diferencia entre cambiar de pestaña y perder la sesión:
 * desmontarlas mataría el ssh y borraría el scrollback cada vez.
 */

const PUNTO: Record<string, string> = {
  abriendo: "bg-warning animate-pulse",
  viva: "bg-success",
  terminada: "bg-muted-foreground",
  rota: "bg-destructive",
};

export default function TerminalPanel() {
  const { sesiones, activa, abierto, maximizado, alto } = useTerminals();
  const activar = useTerminals((s) => s.activar);
  const cerrar = useTerminals((s) => s.cerrar);
  const cerrarTodas = useTerminals((s) => s.cerrarTodas);
  const setMaximizado = useTerminals((s) => s.setMaximizado);
  const setAlto = useTerminals((s) => s.setAlto);
  const arrastrando = useRef(false);

  // Arrastrar el borde de arriba. Con captura del puntero: sin ella, mover
  // rápido saca el ratón del borde de 4px y el arrastre se corta solo.
  const empezarArrastre = useCallback(
    (e: React.PointerEvent) => {
      if (maximizado) return;
      arrastrando.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [maximizado],
  );
  const arrastrar = useCallback(
    (e: React.PointerEvent) => {
      if (!arrastrando.current) return;
      setAlto(Math.min(window.innerHeight - 120, window.innerHeight - e.clientY));
    },
    [setAlto],
  );
  const soltar = useCallback((e: React.PointerEvent) => {
    arrastrando.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  if (!abierto || sesiones.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-col border-t bg-card",
        maximizado ? "min-h-0 flex-1" : "shrink-0",
      )}
      style={maximizado ? undefined : { height: alto }}
    >
      <div
        onPointerDown={empezarArrastre}
        onPointerMove={arrastrar}
        onPointerUp={soltar}
        className={cn(
          "h-1 shrink-0 hover:bg-primary/40",
          maximizado ? "cursor-default" : "cursor-row-resize",
        )}
      />
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <TerminalSquare className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {/* Dos botones hermanos y no uno dentro de otro: anidar controles
              es HTML inválido, y el de dentro deja de alcanzarse tabulando. */}
          {sesiones.map((s) => (
            <div
              key={s.key}
              className={cn(
                "group flex shrink-0 items-center rounded text-xs",
                s.key === activa
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <button
                onClick={() => activar(s.key)}
                title={s.detalle ?? s.label}
                className="flex items-center gap-1.5 py-1 pl-2 pr-1"
              >
                <span className={cn("size-1.5 rounded-full", PUNTO[s.estado])} />
                <span className="max-w-40 truncate">{s.label}</span>
              </button>
              <button
                aria-label={`Close ${s.label}`}
                onClick={() => cerrar(s.key)}
                className="mr-1 rounded p-0.5 opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setMaximizado(!maximizado)}
          title={maximizado ? "Restore" : "Maximize"}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {maximizado ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
        <button
          onClick={cerrarTodas}
          title="Close every session"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 bg-[#0b0d10] p-1.5">
        {sesiones.map((s) => (
          <div
            key={s.key}
            className="h-full w-full"
            style={{ display: s.key === activa ? "block" : "none" }}
          >
            <TerminalView sesion={s} visible={s.key === activa} />
          </div>
        ))}
      </div>
    </div>
  );
}
