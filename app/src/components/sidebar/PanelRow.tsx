import DisclosureChevron from "@/components/ui/disclosure-chevron";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Una fila del panel: icono, nombre, y a la derecha lo que haga falta.
 *
 * Es la unidad de todos los paneles del sidebar, para que una fila de
 * Plataforma y una de Comunicación se lean igual. Las acciones de fila salen
 * al pasar el ratón **y al enfocar** (`group-focus-within`), nunca con
 * `opacity-0`: eso deja un botón invisible en el orden de tabulación, que es
 * justo lo que la prueba de a11y del árbol no deja pasar.
 */
export default function PanelRow({
  icon,
  label,
  badge,
  active,
  depth = 0,
  onClick,
  actions,
  expandable,
  title,
  className,
  preview,
  meta,
}: {
  icon?: ReactNode;
  label: string;
  /** Un número a la derecha, o un nodo propio. Nada con 0. */
  badge?: number | ReactNode;
  /**
   * `true`: es lo que tienes delante, con fondo. `"path"`: lo que tienes
   * delante cuelga de aquí y se ve debajo; sólo en negrita, para que no haya
   * dos filas con fondo una encima de otra.
   */
  active?: boolean | "path";
  /** Para sangrar: un nivel son 12px, como en el árbol de páginas. */
  depth?: number;
  onClick: () => void;
  /** Botones que salen al pasar el ratón o enfocar la fila. */
  actions?: ReactNode;
  /** Con chevrón: la fila tiene hijos, y el chevrón los abre sin navegar. */
  expandable?: { open: boolean; onToggle: () => void; collapseLabel: string; expandLabel: string };
  title?: string;
  className?: string;
  /**
   * Una segunda línea debajo del nombre: el último mensaje de un canal o un
   * directo, como en WhatsApp. Con ella el contador baja a su altura y la hora
   * (`meta`) se queda arriba, a la derecha del nombre.
   */
  preview?: ReactNode;
  /** Arriba a la derecha, junto al nombre: la hora del último mensaje. */
  meta?: ReactNode;
}) {
  const pill =
    typeof badge === "number" ? (
      badge > 0 && (
        <span className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )
    ) : (
      badge
    );

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 text-sm",
        active === true
          ? "bg-accent font-medium text-accent-foreground"
          : active === "path"
            ? "font-medium text-foreground hover:bg-accent/50"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        className,
      )}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      {expandable && (
        <button
          type="button"
          aria-expanded={expandable.open}
          aria-label={expandable.open ? expandable.collapseLabel : expandable.expandLabel}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          onClick={expandable.onToggle}
        >
          <DisclosureChevron open={expandable.open} className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onClick}
        aria-current={active === true ? "page" : active === "path" ? "location" : undefined}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
      >
        {icon && <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{icon}</span>}
        {preview || meta ? (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {meta && <span className="shrink-0 text-[10px] font-normal text-muted-foreground">{meta}</span>}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">{preview}</span>
              {pill}
            </span>
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {pill}
          </>
        )}
      </button>
      {actions && (
        <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
          {actions}
        </span>
      )}
    </div>
  );
}
