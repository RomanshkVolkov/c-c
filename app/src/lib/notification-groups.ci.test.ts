import { describe, expect, it } from "vitest";
import { groupInbox, groupKeyOf, summarize } from "@/lib/notification-groups";
import type { InboxItem } from "@/store/inbox.store";

/**
 * La actividad de CI en la campana (R9): los runs se pliegan por repo y los
 * deploys por servicio, con la clave que manda el servidor y **nunca** una
 * deducida del enlace —el enlace lleva `owner/repo`, no el id del repo—. Y se
 * leen como una tarea: el rótulo es el repo o el servicio, y la segunda línea
 * dice qué pasó.
 */

const run = (extra: Partial<InboxItem> & { id: string }): InboxItem => ({
  orgId: "o",
  kind: "ci:run",
  title: "Deploy failed on main",
  body: "dwit/api · `abc1234` · @ana",
  link: "/activity?repo=dwit%2Fapi&run=r-1",
  groupKey: "repo:100",
  groupLabel: "dwit/api",
  createdAt: "2026-10-04T10:00:00Z",
  ...extra,
});

describe("la actividad de CI en la campana", () => {
  it("un run se agrupa por lo que dice el servidor, y sin clave va suelto", () => {
    expect(groupKeyOf(run({ id: "a" }))).toBe("repo:100");
    // Sin clave no se inventa una del enlace: `repo=dwit/api` no es `repo:100`.
    expect(groupKeyOf(run({ id: "b", groupKey: undefined }))).toBe("");
    const grupos = groupInbox([run({ id: "a" }), run({ id: "b", groupKey: undefined })]);
    expect(grupos.map((g) => g.key).sort()).toEqual(["b", "repo:100"]);
  });

  it("cuatro runs del mismo repo son una fila con el repo arriba y lo que pasó abajo", () => {
    const [g] = groupInbox([
      run({ id: "1", createdAt: "2026-10-04T10:00:00Z", title: "Tests passed on main" }),
      run({ id: "2", createdAt: "2026-10-04T10:01:00Z" }),
      run({ id: "3", createdAt: "2026-10-04T10:02:00Z" }),
      run({ id: "4", createdAt: "2026-10-04T10:03:00Z", title: "Deploy failed on main" }),
    ]);
    expect(g.items).toHaveLength(4);
    const s = summarize(g);
    expect(s.count).toBe(4);
    expect(s.title).toBe("dwit/api");
    expect(s.detail).toBe("Deploy failed on main");
    expect(s.link).toBe("/activity?repo=dwit%2Fapi&run=r-1");
  });

  it("un deploy acabado se pliega por servicio, aparte de los runs de su repo", () => {
    const grupos = groupInbox([
      run({ id: "r" }),
      run({ id: "d", kind: "deploy:done", title: "api deployed · abc1234", body: "prod · `abc1234`",
        link: "/activity?deployable=dp-1&deployment=x", groupKey: "deployable:dp-1", groupLabel: "api" }),
    ]);
    expect(grupos.map((g) => g.key).sort()).toEqual(["deployable:dp-1", "repo:100"]);
    const dep = grupos.find((g) => g.key === "deployable:dp-1")!;
    expect(summarize(dep)).toMatchObject({ title: "api", detail: "api deployed · abc1234" });
  });
});
