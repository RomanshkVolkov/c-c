/**
 * Las piezas puras de correr un playbook desde la app: qué se guarda de una
 * ejecución en cac. Nunca un valor: nombres de variables, el resumen y la cola
 * de la salida, que ya llega tachada desde Rust.
 */

const ANSI = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Las líneas que se guardan en memoria de una ejecución en curso. */
export const MAX_LINES = 2000;

/** Las que se mandan a cac al acabar (el backend también lo acota). */
export const TAIL_LINES = 200;

/** El `PLAY RECAP` del final, sin color: lo que dice cómo acabó cada host. */
export function playRecap(lines: string[]): string {
  let i = lines.length - 1;
  while (i >= 0 && !stripAnsi(lines[i]).startsWith("PLAY RECAP")) i--;
  if (i < 0) return "";
  return lines
    .slice(i)
    .map(stripAnsi)
    .filter((l) => l.trim() !== "")
    .join("\n");
}

export function logTail(lines: string[], n = TAIL_LINES): string {
  return lines.slice(-n).map(stripAnsi).join("\n");
}

/** Cómo acabó, en las palabras de cac. */
export function finalStatus(code: number | null, cancelled: boolean): "succeeded" | "failed" | "cancelled" {
  if (cancelled) return "cancelled";
  return code === 0 ? "succeeded" : "failed";
}

/** Añade líneas sin pasarse del tope: se quedan las últimas. */
export function appendBounded(prev: string[], more: string[], max = MAX_LINES): string[] {
  const next = prev.concat(more);
  return next.length > max ? next.slice(next.length - max) : next;
}
