import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Un panel que se abre desde un botón, con el movimiento de la app: nace del
 * botón con muelle (`motion-pop`) y sale encogiéndose.
 *
 * Para los menús y paneles que estaban hechos a mano con `open && <div>`:
 * aparecían de golpe, no se cerraban con Escape ni al pulsar fuera, y cada
 * uno lo resolvía a su manera. Éste lo trae todo de base-ui.
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  className,
}: {
  /** El botón que lo abre (un elemento; base-ui le pone los eventos). */
  trigger: React.ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger render={trigger} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
          <PopoverPrimitive.Popup
            className={cn(
              "motion-pop rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
              className,
            )}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
