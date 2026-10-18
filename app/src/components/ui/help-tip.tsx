import { Popover } from "@base-ui/react/popover";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Un «?» junto a un campo que, al pulsarlo, explica qué es y da un ejemplo.
 *
 * Se abre con clic y no al pasar el ratón: así funciona con teclado y en una
 * pantalla táctil, y se puede leer con calma. Para lo que no cabe en la
 * descripción de debajo del campo (jose, 18-oct-2026: «no entiendo qué hacen
 * algunos inputs»).
 */
export function HelpTip({
  label,
  children,
  example,
  exampleLabel,
  className,
}: {
  /** Para lectores de pantalla: «Ayuda: Base». */
  label: string;
  children: ReactNode;
  /** Un valor de ejemplo, en monoespaciada. */
  example?: string;
  /** El texto delante del ejemplo, ya traducido («Ejemplo»). */
  exampleLabel?: string;
  className?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
      >
        <CircleHelp className="size-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="z-[60]">
          <Popover.Popup className="max-w-xs space-y-1.5 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-md">
            <div className="leading-relaxed">{children}</div>
            {example && (
              <p className="text-muted-foreground">
                {exampleLabel}: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{example}</code>
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
