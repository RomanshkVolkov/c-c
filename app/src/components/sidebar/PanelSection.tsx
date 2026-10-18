import DisclosureChevron from "@/components/ui/disclosure-chevron";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Una sección del panel: cabecera en mayúsculas que pliega lo que lleva dentro.
 *
 * Se pliega pulsando la cabecera, como en Notion; la cuenta de la derecha
 * sigue viéndose plegada, que es lo que hace útil plegar una sección de
 * canales sin perder cuántos tienes sin leer.
 *
 * `peek` es lo que se sigue viendo plegada, como en Slack: la fila en la que
 * estás y las que tienen algo sin leer. Plegar es «no me enseñes lo que no
 * me importa ahora», no «escóndeme el canal que tengo delante».
 */
export default function PanelSection({
  label,
  count,
  open,
  onToggle,
  action,
  children,
  peek,
  className,
}: {
  label: string;
  /** Un número a la derecha de la cabecera. Nada con 0. */
  count?: number;
  open: boolean;
  onToggle: () => void;
  /** Un botón a la derecha (crear, bloquear…); no se pliega con la sección. */
  action?: ReactNode;
  children: ReactNode;
  /** Lo que sigue a la vista con la sección plegada. */
  peek?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("py-1", className)}>
      <div className="flex h-7 items-center gap-1 pr-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <DisclosureChevron open={open} className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
          {!!count && count > 0 && (
            <span className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium normal-case tracking-normal text-primary-foreground">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
        {action}
      </div>
      {open ? <div className="motion-reveal px-1">{children}</div> : peek && <div className="px-1">{peek}</div>}
    </section>
  );
}
