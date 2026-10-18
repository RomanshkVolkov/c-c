import { Popover } from "@base-ui/react/popover";
import { Check } from "lucide-react";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Los colores que se pueden elegir para un espacio o una etiqueta.
 *
 * Una paleta fija y no un selector libre: el color se guarda como hex, uno
 * solo para los dos temas, y un tono medio es lo único que se ve igual de
 * bien sobre el fondo claro que sobre el oscuro. Por eso además el texto de
 * una etiqueta va en el color de siempre y su color va en el punto
 * (`TagChip`): un amarillo como texto no se lee en claro.
 */
export const PALETTE: { hex: string; name: MessageKey }[] = [
  { hex: "#3B82F6", name: "common:colors.blue" },
  { hex: "#06B6D4", name: "common:colors.cyan" },
  { hex: "#14B8A6", name: "common:colors.teal" },
  { hex: "#22C55E", name: "common:colors.green" },
  { hex: "#EAB308", name: "common:colors.yellow" },
  { hex: "#F97316", name: "common:colors.orange" },
  { hex: "#EF4444", name: "common:colors.red" },
  { hex: "#EC4899", name: "common:colors.pink" },
  { hex: "#8B5CF6", name: "common:colors.violet" },
  { hex: "#64748B", name: "common:colors.slate" },
];

/** Un color por defecto para algo nuevo, estable para el mismo nombre. */
export function paletteFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length].hex;
}

export function ColorSwatches({ value, onChange }: { value?: string; onChange: (hex: string) => void }) {
  const { t } = useT();
  const current = value?.toLowerCase();
  return (
    <div role="group" aria-label={t("common:colors.pick")} className="grid grid-cols-5 gap-1.5">
      {PALETTE.map((c) => {
        const on = current === c.hex.toLowerCase();
        return (
          <button
            key={c.hex}
            type="button"
            aria-label={t(c.name)}
            aria-pressed={on}
            title={t(c.name)}
            onClick={() => onChange(c.hex)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-popover transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-ring",
              on && "ring-2 ring-foreground/70",
            )}
            style={{ backgroundColor: c.hex }}
          >
            {on && <Check className="size-3.5 text-white" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Un punto de color que, al pulsarlo, deja elegir otro.
 *
 * Es el propio punto el que se pulsa, en el sitio donde se ve el color: un
 * «Cambiar color» en un menú obliga a ir a buscar algo que ya está a la vista.
 */
export function ColorDot({
  color,
  onChange,
  label,
  className,
}: {
  color: string;
  onChange: (hex: string) => void;
  /** Para lectores de pantalla: «Color de Producto». */
  label: string;
  className?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "shrink-0 rounded-full transition-transform hover:scale-125 focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
        style={{ backgroundColor: color }}
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-[60]">
          <Popover.Popup
            onClick={(e) => e.stopPropagation()}
            className="motion-pop rounded-lg border bg-popover p-2 shadow-md"
          >
            <ColorSwatches value={color} onChange={onChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
