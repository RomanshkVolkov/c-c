import { describe, expect, it } from "vitest";
import { groupAttempts } from "./run-attempts";
import type { ActivityEntry } from "@/types/activity";

/**
 * Los intentos de un run, en una entrada. El caso real (jose, 7-oct-2026,
 * tds-geolocation): intento 1 pasó, 2 falló, 3 pasó; la lista enseñaba el
 * fallo del 2 como si estuviera sin resolver. Mutantes: no agrupar; quedarse
 * con el primero que llega y no con el último intento; perder los deploys de
 * un intento anterior; juntar runs distintos.
 */
const run = (runId: number, runAttempt: number, conclusion: string, deployments: string[] = []): ActivityEntry => ({
  kind: "run",
  at: "2026-10-07T20:38:47Z",
  run: { id: `r${runId}-${runAttempt}`, runId, runAttempt, status: "completed", conclusion } as never,
  deployments: deployments.map((id) => ({ id }) as never),
});

describe("los intentos de un run", () => {
  it("van juntos: el último arriba, los demás en orden", () => {
    const out = groupAttempts([run(9, 2, "failure"), run(9, 1, "success"), run(9, 3, "success")]);
    expect(out).toHaveLength(1);
    const g = out[0];
    if (g.kind !== "run") throw new Error("no es un run");
    expect(g.run.runAttempt).toBe(3);
    expect(g.run.conclusion).toBe("success");
    expect(g.earlier.map((r) => r.runAttempt)).toEqual([1, 2]);
  });

  it("no junta runs distintos, y conserva los deploys de cada intento", () => {
    const out = groupAttempts([run(9, 1, "success", ["d1"]), run(8, 1, "failure"), run(9, 2, "success", ["d2"])]);
    expect(out.map((e) => (e.kind === "run" ? e.run.runId : 0))).toEqual([9, 8]);
    const g = out[0];
    if (g.kind !== "run") throw new Error("no es un run");
    expect(g.deployments.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
  });
});
