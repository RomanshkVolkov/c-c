import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invariant that keeps a half-written description alive.
 *
 * Writing one and creating a subtask used to wipe it. The drawer only renders
 * its body while `detail` exists, so anything that blanked `detail` before
 * refetching unmounted the editor — and the draft went with it. The same thing
 * fired on every live event for the open list, so a colleague moving an
 * unrelated card was enough.
 *
 * These assert the *sequence* of states, not the final one: the bug was a blink
 * to null in the middle, and a test that only looked at the end would have
 * passed throughout.
 */

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(async () => ({ success: true })),
    patch: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true })),
    postForm: vi.fn(async () => ({ success: true, data: { url: "/api/x", fileName: "f.pdf" } })),
  },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
// subscribe too: the store wires a logout listener onto it at import time.
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));
vi.mock("@/store/orgs.store", () => ({ useOrgsStore: { getState: () => ({ currentOrgId: "org" }) } }));

const { api } = await import("@/lib/api");
const { useTasksStore } = await import("@/store/tasks.store");

const detailFor = (title: string) =>
  ({
    task: { id: "task-1", title, description: "lo que estoy escribiendo" },
    listName: "L", spaceName: "S", status: {}, tags: [],
    assignees: [], comments: [], attachments: [], subtasks: [],
  }) as never;

/** Every value `detail` took while `run` was in flight, in order. */
async function detailStatesDuring(run: () => Promise<unknown>) {
  const seen: unknown[] = [useTasksStore.getState().detail];
  const unsubscribe = useTasksStore.subscribe((s) => seen.push(s.detail));
  await run();
  unsubscribe();
  return seen;
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ success: true, data: detailFor("recargada") } as never);
  useTasksStore.setState({
    openTaskId: "task-1",
    detail: detailFor("original"),
    activeListId: "list-1",
    board: null,
  });
});

describe("refrescar la tarea abierta", () => {
  it("no pasa por null en ningún momento", async () => {
    const seen = await detailStatesDuring(() => useTasksStore.getState().refreshOpenTask());
    expect(seen.every((d) => d !== null)).toBe(true);
    expect(useTasksStore.getState().detail).not.toBeNull();
  });

  it("sustituye el contenido, así que sí trae los datos nuevos", async () => {
    await useTasksStore.getState().refreshOpenTask();
    const detail = useTasksStore.getState().detail as unknown as { task: { title: string } };
    expect(detail.task.title).toBe("recargada");
  });

  // Each of these refreshed by calling openTask, which blanks first. Naming them
  // one by one so a regression says which path came back.
  it.each([
    ["crear una subtarea", () => useTasksStore.getState().createSubtask("task-1", "sub")],
    ["editar un comentario", () => useTasksStore.getState().editComment("task-1", "c1", "x")],
    ["borrar un comentario", () => useTasksStore.getState().deleteComment("task-1", "c1")],
    ["borrar un adjunto", () => useTasksStore.getState().deleteAttachment("task-1", "a1")],
    ["subir un adjunto", () => useTasksStore.getState().uploadAttachment("task-1", new File([""], "f.pdf"))],
  ])("%s no desmonta el panel", async (_name, run) => {
    const seen = await detailStatesDuring(run);
    expect(seen.every((d) => d !== null)).toBe(true);
  });
});

describe("abrir una tarea distinta", () => {
  it("sí blanquea, y esa diferencia es el punto", async () => {
    // Not an accident: switching tasks *should* drop the draft, because it
    // belongs to the task being left. Refreshing the same one must not.
    const seen = await detailStatesDuring(() => useTasksStore.getState().openTask("task-2"));
    expect(seen).toContain(null);
  });
});
