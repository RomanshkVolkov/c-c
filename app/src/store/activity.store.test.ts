import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La actividad de CI se **funde** con lo que llega del stream (R9).
 *
 * Lo que se fija: un run que avanza pisa su fila sin moverla de sitio ni
 * perder los deploys que colgaban de ella; uno nuevo entra donde le toca por
 * fecha, no arriba del todo; con la página filtrada por repo no entra el run
 * de otro; un deploy en vivo se cuelga de su run por `workflowRunId`; y la
 * siguiente página se pide con el cursor de la última fila.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));

const { useActivityStore, upsertEntry, matchesFilter } = await import("./activity.store");
import type { ActivityDeployment, ActivityEntry, WorkflowRun } from "@/types/activity";

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r-1", orgId: "org-1", repoId: 100, repoFullName: "dwit/api", runId: 9, runAttempt: 1, runNumber: 41,
  workflowName: "Deploy", path: ".github/workflows/prod.yml", event: "push", status: "in_progress", conclusion: "",
  headSha: "abc1234def", headBranch: "main", commitTitle: "fix", actor: "ana",
  htmlUrl: "https://github.com/dwit/api/actions/runs/9", occurredAt: "2026-10-04T10:00:00Z",
  ...over,
});

const dep = (over: Partial<ActivityDeployment> = {}): ActivityDeployment =>
  ({
    id: "d-1", orgId: "org-1", createdAt: "2026-10-04T10:05:00Z", deployableId: "dp-1", serverId: "srv-1",
    image: "ghcr.io/dwit/api:abc1234", finalImage: "", previousImage: "", requestedBy: "github",
    requestedByUserId: "", status: "queued", error: "", rollbackOfId: "",
    deployableName: "api", deployableEnv: "prod",
    ...over,
  }) as ActivityDeployment;

const entryOf = (r: WorkflowRun): ActivityEntry => ({ kind: "run", at: r.occurredAt, run: r });

beforeEach(() => {
  useActivityStore.setState({ orgId: "org-1", filter: {}, entries: [], hasMore: false, loading: false, error: null });
  get.mockReset();
});

describe("fundir lo que llega", () => {
  it("un run que avanza pisa su fila, sin moverla ni perder sus deploys", () => {
    const d = dep({ workflowRunId: "r-1" });
    useActivityStore.setState({
      entries: [
        entryOf(run({ id: "r-2", occurredAt: "2026-10-04T11:00:00Z" })),
        { kind: "run", at: "2026-10-04T10:00:00Z", run: run(), deployments: [d] },
      ],
    });
    useActivityStore.getState().onRun(run({ status: "completed", conclusion: "success" }));
    const entries = useActivityStore.getState().entries;
    expect(entries.map((e) => (e.kind === "run" ? e.run.id : ""))).toEqual(["r-2", "r-1"]);
    const e = entries[1];
    expect(e.kind === "run" && e.run.conclusion).toBe("success");
    expect(e.kind === "run" && e.deployments?.[0].id).toBe("d-1");
  });

  it("uno nuevo entra donde le toca por fecha, el más nuevo primero", () => {
    useActivityStore.setState({
      entries: [
        entryOf(run({ id: "r-3", occurredAt: "2026-10-04T12:00:00Z" })),
        entryOf(run({ id: "r-1", occurredAt: "2026-10-04T10:00:00Z" })),
      ],
    });
    useActivityStore.getState().onRun(run({ id: "r-2", occurredAt: "2026-10-04T11:00:00Z" }));
    expect(useActivityStore.getState().entries.map((e) => (e.kind === "run" ? e.run.id : ""))).toEqual(["r-3", "r-2", "r-1"]);
  });

  it("dos a ambos lados de medianoche se ordenan por el instante, no por el día local", () => {
    // 23:30 UTC del 3 y 00:30 UTC del 4: en UTC−6 son el mismo día; en UTC+13 son
    // días distintos al revés. El orden tiene que ser el mismo en las tres zonas.
    const a = run({ id: "a", occurredAt: "2026-10-03T23:30:00Z" });
    const b = run({ id: "b", occurredAt: "2026-10-04T00:30:00Z" });
    useActivityStore.setState({ entries: [entryOf(a)] });
    useActivityStore.getState().onRun(b);
    expect(useActivityStore.getState().entries.map((e) => (e.kind === "run" ? e.run.id : ""))).toEqual(["b", "a"]);
  });

  it("con la página filtrada por repo, el run de otro repo no entra; el del repo sí", () => {
    useActivityStore.setState({ filter: { repo: "dwit/api" } });
    useActivityStore.getState().onRun(run({ id: "otro", repoFullName: "dwit/web" }));
    expect(useActivityStore.getState().entries).toHaveLength(0);
    useActivityStore.getState().onRun(run({ repoFullName: "DWIT/API" }));
    expect(useActivityStore.getState().entries).toHaveLength(1);
  });

  it("un run de otra org, o un evento vacío, no toca nada", () => {
    useActivityStore.getState().onRun(run({ orgId: "org-2" }));
    useActivityStore.getState().onRun({} as WorkflowRun);
    expect(useActivityStore.getState().entries).toHaveLength(0);
  });

  it("un deploy en vivo se cuelga de su run y entra como fila", () => {
    useActivityStore.setState({ entries: [entryOf(run())] });
    useActivityStore.getState().onDeployStatus(dep({ workflowRunId: "r-1" }));
    const entries = useActivityStore.getState().entries;
    expect(entries.map((e) => e.kind)).toEqual(["deployment", "run"]);
    const r = entries[1];
    expect(r.kind === "run" && r.deployments?.map((d) => d.id)).toEqual(["d-1"]);
    // Y al avanzar, pisa las dos copias sin perder el nombre del servicio.
    useActivityStore.getState().onDeployStatus({ ...dep({ workflowRunId: "r-1", status: "succeeded" }), deployableName: "" } as ActivityDeployment);
    const after = useActivityStore.getState().entries;
    expect(after[0].kind === "deployment" && after[0].deployment.status).toBe("succeeded");
    expect(after[0].kind === "deployment" && after[0].deployment.deployableName).toBe("api");
    expect(after[1].kind === "run" && after[1].deployments?.[0].status).toBe("succeeded");
  });
});

describe("las piezas puras", () => {
  it("matchesFilter: por servicio, un run no entra en vivo (no se sabe de quién es) y un deploy sólo el suyo", () => {
    expect(matchesFilter(entryOf(run()), { deployableId: "dp-1" })).toBe(false);
    expect(matchesFilter({ kind: "deployment", at: "x", deployment: dep() }, { deployableId: "dp-1" })).toBe(true);
    expect(matchesFilter({ kind: "deployment", at: "x", deployment: dep({ deployableId: "dp-2" }) }, { deployableId: "dp-1" })).toBe(false);
  });

  it("upsertEntry desempata el mismo instante por id, como el servidor", () => {
    const a = entryOf(run({ id: "a", occurredAt: "2026-10-04T10:00:00Z" }));
    const b = entryOf(run({ id: "b", occurredAt: "2026-10-04T10:00:00Z" }));
    expect(upsertEntry([a], b).map((e) => (e.kind === "run" ? e.run.id : ""))).toEqual(["b", "a"]);
    expect(upsertEntry([b], a).map((e) => (e.kind === "run" ? e.run.id : ""))).toEqual(["b", "a"]);
  });
});

describe("pedir páginas", () => {
  it("la primera lleva el filtro y la siguiente el cursor de la última fila", async () => {
    get.mockResolvedValueOnce({ success: true, data: { items: [entryOf(run({ id: "r-2", occurredAt: "2026-10-04T11:00:00Z" })), entryOf(run())], hasMore: true } });
    await useActivityStore.getState().load("org-1", { repo: "dwit/api" });
    expect(get).toHaveBeenCalledTimes(1);
    const first = String(get.mock.calls[0][0]);
    expect(first).toContain("/api/v1/organizations/org-1/activity/?");
    expect(first).toContain("repo=dwit%2Fapi");
    expect(first).not.toContain("before=");
    expect(useActivityStore.getState().hasMore).toBe(true);

    get.mockResolvedValueOnce({ success: true, data: { items: [entryOf(run({ id: "r-0", occurredAt: "2026-10-04T09:00:00Z" }))], hasMore: false } });
    await useActivityStore.getState().loadMore();
    const second = String(get.mock.calls[1][0]);
    expect(second).toContain("before=2026-10-04T10%3A00%3A00Z");
    expect(second).toContain("beforeId=r-1");
    expect(useActivityStore.getState().entries.map((e) => (e.kind === "run" ? e.run.id : ""))).toEqual(["r-2", "r-1", "r-0"]);
    expect(useActivityStore.getState().hasMore).toBe(false);
  });

  it("una respuesta de un filtro que ya no es el de la página se descarta", async () => {
    let resolve: (v: unknown) => void = () => {};
    get.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = useActivityStore.getState().load("org-1", { repo: "dwit/api" });
    get.mockResolvedValueOnce({ success: true, data: { items: [], hasMore: false } });
    await useActivityStore.getState().load("org-1", {});
    resolve({ success: true, data: { items: [entryOf(run())], hasMore: false } });
    await first;
    expect(useActivityStore.getState().entries).toHaveLength(0);
  });
});
