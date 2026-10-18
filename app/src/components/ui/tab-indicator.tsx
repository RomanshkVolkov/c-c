import type { IndicatorRect } from "@/lib/use-sliding-indicator";
import { cn } from "@/lib/utils";

/**
 * El indicador de la pestaña activa, que se desliza con muelle hasta la nueva.
 *
 * Dos formas: `underline` (la raya de debajo) y `pill` (el fondo de un
 * conmutador segmentado). Se mueve con `translate`, que lo hace el
 * compositor; la anchura también cambia, pero es un elemento suelto
 * (`absolute`) de un par de píxeles de alto y no recalcula nada a su
 * alrededor.
 *
 * Va dentro de la barra (`relative`), con las medidas de
 * `useSlidingIndicator`. La primera vez aparece en su sitio, sin deslizarse.
 */
export default function TabIndicator({
  rect,
  first,
  variant = "underline",
  className,
}: {
  rect: IndicatorRect | null;
  first?: boolean;
  variant?: "underline" | "pill";
  className?: string;
}) {
  if (!rect) return null;
  const pill = variant === "pill";
  return (
    <span
      aria-hidden
      data-slot="tab-indicator"
      className={cn(
        "pointer-events-none absolute left-0",
        pill ? "top-0 rounded-md bg-accent" : "-bottom-px h-0.5 rounded-full bg-primary",
        !first && "transition-[translate,width,height] duration-(--dur-spring) ease-(--ease-spring)",
        className,
      )}
      style={{
        width: rect.w,
        height: pill ? rect.h : undefined,
        translate: pill ? `${rect.x}px ${rect.y}px` : `${rect.x}px 0`,
      }}
    />
  );
}
