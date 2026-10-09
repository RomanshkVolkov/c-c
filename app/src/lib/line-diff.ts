import { diffLines } from "diff";

/**
 * Lo que cambió entre dos textos, línea a línea, para enseñarlo.
 *
 * Las líneas iguales largas se pliegan dejando `context` por cada lado: en un
 * runbook de 3000 líneas donde cambió un párrafo, lo que se quiere ver es el
 * párrafo, no tres mil líneas en gris (es lo que hace GitHub en un diff).
 */
export type DiffRow =
  | { kind: "same" | "add" | "del"; text: string }
  | { kind: "skip"; count: number };

export function lineDiff(before: string, after: string, context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    if (part.added || part.removed) {
      for (const text of lines) rows.push({ kind: part.added ? "add" : "del", text });
    } else {
      for (const text of lines) rows.push({ kind: "same", text });
    }
  }
  // Plegar: una línea igual se queda si hay un cambio a `context` líneas o menos.
  const cerca = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.kind === "add" || r.kind === "del") {
      for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) cerca[j] = true;
    }
  });
  const out: DiffRow[] = [];
  let saltadas = 0;
  rows.forEach((r, i) => {
    if (r.kind === "same" && !cerca[i]) {
      saltadas++;
      return;
    }
    if (saltadas > 0) out.push({ kind: "skip", count: saltadas });
    saltadas = 0;
    out.push(r);
  });
  if (saltadas > 0) out.push({ kind: "skip", count: saltadas });
  return out;
}

/** Cuántas líneas entran y salen: el resumen que se lee antes que el detalle. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}
