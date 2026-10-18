import { normalizeStatus } from "@/types/report";

/**
 * Cómo se pinta un estado: su punto, su texto, su chip y el filo de su
 * columna, con los `--status-*` de `index.css`.
 *
 * El hex que manda el servidor con cada columna (`boardColumns`) no se usa:
 * es uno solo para los dos temas, y el ámbar que se lee en oscuro no se lee
 * en claro. Lo que cuenta es qué estado es, y eso lo dice `status`.
 *
 * Literales enteros, porque Tailwind sólo genera las clases que encuentra.
 */
export interface StatusTone {
  dot: string;
  text: string;
  chip: string;
  edge: string;
}

const TONES = {
  open: {
    dot: "bg-status-open",
    text: "text-status-open",
    chip: "bg-status-open/15 text-status-open",
    edge: "border-t-status-open",
  },
  in_progress: {
    dot: "bg-status-progress",
    text: "text-status-progress",
    chip: "bg-status-progress/15 text-status-progress",
    edge: "border-t-status-progress",
  },
  done: {
    dot: "bg-status-done",
    text: "text-status-done",
    chip: "bg-status-done/15 text-status-done",
    edge: "border-t-status-done",
  },
  closed: {
    dot: "bg-status-closed",
    text: "text-status-closed",
    chip: "bg-status-closed/15 text-status-closed",
    edge: "border-t-status-closed",
  },
} as const satisfies Record<string, StatusTone>;

/** Un estado que esta versión no conoce: gris, y no el de otro estado. */
const UNKNOWN: StatusTone = {
  dot: "bg-muted-foreground",
  text: "text-muted-foreground",
  chip: "bg-muted text-muted-foreground",
  edge: "border-t-border",
};

/** Acepta los nombres viejos (`pending`, `resolved`) y los de ahora. */
export function statusTone(status: string | undefined): StatusTone {
  if (!status) return UNKNOWN;
  return TONES[normalizeStatus(status) as keyof typeof TONES] ?? UNKNOWN;
}
