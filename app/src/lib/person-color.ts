/**
 * Un color estable para algo que necesita distinguirse sin significar nada:
 * una persona (su avatar) o un espacio sin color propio.
 *
 * Antes todos eran el cian del acento, y el cian dejaba de decir «esto se
 * pulsa» porque lo decía todo. La paleta son los ocho `--hue-*` de
 * `index.css`, con contraste comprobado en los dos temas
 * (`theme.contrast.test.ts`).
 *
 * Las clases van escritas enteras y no montadas con el número: Tailwind sólo
 * genera las que encuentra literales en el código.
 */
const TINTS = [
  "bg-hue-1/15 text-hue-1",
  "bg-hue-2/15 text-hue-2",
  "bg-hue-3/15 text-hue-3",
  "bg-hue-4/15 text-hue-4",
  "bg-hue-5/15 text-hue-5",
  "bg-hue-6/15 text-hue-6",
  "bg-hue-7/15 text-hue-7",
  "bg-hue-8/15 text-hue-8",
] as const;

const VARS = [
  "var(--hue-1)",
  "var(--hue-2)",
  "var(--hue-3)",
  "var(--hue-4)",
  "var(--hue-5)",
  "var(--hue-6)",
  "var(--hue-7)",
  "var(--hue-8)",
] as const;

/** FNV-1a: corto, sin dependencias, y reparte bien ids parecidos. */
export function hueIndex(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % TINTS.length;
}

/** Fondo tintado y texto, para unas iniciales. */
export const personTint = (id: string) => TINTS[hueIndex(id)];

/** El color como valor CSS, para un punto (`style={{ backgroundColor }}`). */
export const hueVar = (id: string) => VARS[hueIndex(id)];
