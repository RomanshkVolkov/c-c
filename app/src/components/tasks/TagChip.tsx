import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Una etiqueta: su color en el punto y en un tinte de fondo, y el nombre en
 * el color del texto.
 *
 * Antes el nombre iba en el color de la etiqueta, y con un color elegido por
 * alguien eso no se puede garantizar legible en los dos temas (ver
 * `PALETTE`). `dot` deja poner otra cosa en su sitio: en el cajón, el punto
 * que se pulsa para cambiar el color.
 */
export default function TagChip({
  name,
  color,
  dot,
  className,
}: {
  name: string;
  color?: string;
  dot?: ReactNode;
  className?: string;
}) {
  const c = color || "#8B5CF6";
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground", className)}
      style={{ backgroundColor: `${c}26` }}
    >
      {dot ?? <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: c }} />}
      {name}
    </span>
  );
}
