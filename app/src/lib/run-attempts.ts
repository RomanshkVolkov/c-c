import type { ActivityDeployment, ActivityEntry, WorkflowRun } from "@/types/activity";

/**
 * Los intentos de un mismo run, en una sola entrada (jose, 7-oct-2026).
 *
 * El backend guarda una fila por intento, a propósito: un «Re-run» reutiliza el
 * id del run y sube `run_attempt`, y la historia de que falló a la primera no
 * se pierde. Pero enseñar tres filas sueltas confundía: el intento 2 fallido se
 * leía como un fallo sin resolver cuando el 3 había pasado. Aquí se juntan: la
 * entrada es la del **último** intento, y los anteriores van en `earlier` (del
 * primero al penúltimo). Va en el sitio del primero que aparece en el feed.
 */
export type GroupedEntry =
  | { kind: "run"; at: string; run: WorkflowRun; deployments: ActivityDeployment[]; earlier: WorkflowRun[] }
  | Extract<ActivityEntry, { kind: "deployment" }>;

export function groupAttempts(entries: ActivityEntry[]): GroupedEntry[] {
  const out: GroupedEntry[] = [];
  const byRun = new Map<number, Extract<GroupedEntry, { kind: "run" }>>();
  for (const e of entries) {
    if (e.kind !== "run") {
      out.push(e);
      continue;
    }
    const group = byRun.get(e.run.runId);
    if (!group) {
      const g = { kind: "run" as const, at: e.at, run: e.run, deployments: [...(e.deployments ?? [])], earlier: [] as WorkflowRun[] };
      byRun.set(e.run.runId, g);
      out.push(g);
      continue;
    }
    group.deployments.push(...(e.deployments ?? []));
    if (e.run.runAttempt > group.run.runAttempt) {
      group.earlier.push(group.run);
      group.run = e.run;
      group.at = e.at;
    } else {
      group.earlier.push(e.run);
    }
  }
  for (const e of out) if (e.kind === "run") e.earlier.sort((a, b) => a.runAttempt - b.runAttempt);
  return out;
}
