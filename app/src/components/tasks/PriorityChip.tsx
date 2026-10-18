import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * La prioridad como chip: punto y nombre sobre su color al 15%.
 *
 * Era sólo texto de color, y en una columna llena no se distinguía de los
 * demás metadatos. Los colores son `error`/`warning`/`info` y el gris
 * apagado, con el contraste del chip comprobado en `theme.contrast.test.ts`.
 *
 * `none` no pinta nada salvo que se pida (`showNone`, en el cajón, donde el
 * botón tiene que verse para poder ponerle una). Y el nombre sale del
 * catálogo: el de `PRIORITY_META` está en inglés y fijo.
 */
const TONES = {
  urgent: "bg-error/15 text-error",
  high: "bg-warning/15 text-warning",
  normal: "bg-info/15 text-info",
  low: "bg-muted-foreground/15 text-muted-foreground",
  none: "text-muted-foreground",
} as const;

const DOTS = {
  urgent: "bg-error",
  high: "bg-warning",
  normal: "bg-info",
  low: "bg-muted-foreground",
  none: "border border-muted-foreground",
} as const;

type Known = keyof typeof TONES;

/** `medium` es como se guarda la `normal` de la API (ver CLAUDE.md). */
export function canonicalPriority(p: string | undefined): Known | null {
  const v = !p ? "none" : p === "medium" ? "normal" : p;
  return v in TONES ? (v as Known) : null;
}

export default function PriorityChip({
  priority,
  showNone = false,
  className,
}: {
  priority: string | undefined;
  showNone?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const p = canonicalPriority(priority);
  if (p === "none" && !showNone) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-xs font-medium",
        p ? TONES[p] : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", p ? DOTS[p] : "bg-muted-foreground")} />
      {/* Una que esta versión no conoce se enseña por su nombre, sin
          inventarle otra. */}
      {p ? t(`work:taskPriority.${p}`) : priority}
    </span>
  );
}
