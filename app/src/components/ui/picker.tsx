import type { ReactNode } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Un desplegable con la forma de un `<select>` (valor, `onChange`, opciones y
 * grupos) y el aspecto de la app.
 *
 * Existe porque el `<select>` nativo, en la app de Linux (WebKitGTK), abre un
 * menú del sistema: fondo blanco, sin el tema, y tan ancho como la opción más
 * larga, así que una ruta de lista se salía de la ventana (jose, 7-oct-2026).
 * Por dentro es el `Select` de la app (base-ui): se pinta con el tema, cabe en
 * la ventana y hace scroll si no. Para cambiar un `<select>` por éste basta con
 * pasarle las opciones; no hay que montar trigger, contenido e items a mano.
 *
 * `""` sigue siendo «ninguno», como en un `<select>`: por dentro es `null`,
 * que es como lo entiende base-ui.
 */
export interface PickerOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface PickerGroup {
  label: string;
  options: PickerOption[];
}

export interface PickerProps {
  value: string;
  onChange: (value: string) => void;
  /** Opciones sueltas. Se pueden combinar con `groups`: van primero. */
  options?: PickerOption[];
  groups?: PickerGroup[];
  /** Lo que se ve si el valor no es ninguna de las opciones. */
  placeholder?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  size?: "sm" | "default";
  /** Para el botón (anchura, tamaño de letra…). */
  className?: string;
}

const toBase = (v: string) => (v === "" ? null : v);
const fromBase = (v: unknown) => (v == null ? "" : String(v));

export default function Picker({
  value,
  onChange,
  options = [],
  groups = [],
  placeholder,
  disabled,
  id,
  "aria-label": ariaLabel,
  size = "default",
  className,
}: PickerProps) {
  const all = [...options, ...groups.flatMap((g) => g.options)];
  const items = all.map((o) => ({ value: toBase(o.value), label: o.label }));

  const item = (o: PickerOption) => (
    <SelectItem key={`v:${o.value}`} value={toBase(o.value)} disabled={o.disabled}>
      {o.label}
    </SelectItem>
  );

  return (
    <Select
      value={toBase(value)}
      onValueChange={(v) => onChange(fromBase(v))}
      items={items}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        size={size}
        className={cn("min-w-0 max-w-full", className)}
      >
        <SelectValue placeholder={placeholder} className="min-w-0 truncate" />
      </SelectTrigger>
      {/* Tan ancho como el botón, o como la opción más larga, pero nunca más
          que la ventana: el menú nativo se salía por la derecha. */}
      <SelectContent
        alignItemWithTrigger={false}
        className="w-auto min-w-(--anchor-width) max-w-[min(36rem,calc(100vw-2rem))]"
      >
        {options.map(item)}
        {groups.map((g, i) => (
          <SelectGroup key={`g:${g.label}`}>
            {(i > 0 || options.length > 0) && <SelectSeparator />}
            <SelectLabel>{g.label}</SelectLabel>
            {g.options.map(item)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
