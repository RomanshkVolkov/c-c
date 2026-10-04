import { beforeEach, describe, expect, it, vi } from "vitest";

// Cambiar el estado desde el detalle de una tarea abierta fuera de su tablero
// —desde «Mi trabajo», o con otra lista en pantalla— movía la tarea en el
// servidor y dejaba la etiqueta con el estado de antes: nada volvía a leer el
// detalle.

const { get, post } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(async () => ({ success: true, data: {} })),
}));
vi.mock("@/lib/api", () => ({
  api: { get, post, patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "org-1" }) },
}));

const { useTasksStore } = await import("@/store/tasks.store");

const detailWith = (status: string) => ({
  task: { id: "t1", listId: "l1", status },
  status: { id: `l1/${status}`, name: status },
  subtasks: [],
  attachments: [],
  comments: [],
});

describe("changing the status from an open task", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ success: true, data: detailWith("resolved") });
    useTasksStore.setState({
      activeListId: null,
      board: null,
      openTaskId: "t1",
      detail: detailWith("pending") as never,
    });
  });

  it("shows the new status even with no board of that list on screen", async () => {
    await useTasksStore.getState().moveTask("t1", "l1/resolved", "", "");
    expect(get).toHaveBeenCalledWith("/api/v1/tasks/t1");
    expect(useTasksStore.getState().detail?.status.name).toBe("resolved");
  });

  it("re-reads the open parent when what moved was one of its subtasks", async () => {
    await useTasksStore.getState().moveTask("sub1", "l1/resolved", "", "");
    expect(get).toHaveBeenCalledWith("/api/v1/tasks/t1");
  });
});
