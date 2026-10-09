import type { ReactNode } from "react";

import { iniciales } from "@/lib/desde";
import { cn } from "@/lib/utils";

/**
 * Una entrada de una columna plegada: un cuadrado con las iniciales, como los
 * servidores de Discord.
 *
 * Iniciales y no el icono del tipo: en un riel de canales todos serían el mismo
 * `#`, y uno no sabe cuál es cuál sin pasar el ratón por encima de cada uno. El
 * nombre entero va en el `title` y en la etiqueta accesible.
 */
export default function RailItem({
  name,
  active,
  count,
  live,
  icon,
  onClick,
}: {
  name: string;
  active?: boolean;
  /** No leídos. */
  count?: number;
  /** Algo en curso ahí dentro (gente en la voz del canal). */
  live?: boolean;
  /** En vez de las iniciales, cuando el sitio tiene un símbolo propio. */
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-lg text-[11px] font-semibold transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-accent/60 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon ?? iniciales(name)}
      {!!count && count > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[9px] leading-4 text-primary-foreground ring-2 ring-background">
          {count > 99 ? "99+" : count}
        </span>
      )}
      {live && (
        <span
          data-live="true"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-background"
        />
      )}
    </button>
  );
}
