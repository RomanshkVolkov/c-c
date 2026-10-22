import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * De qué depende una tarea se ve en el cajón (22-oct-2026): cada dependencia
 * por su referencia, tachada si ya está hecha, y abre esa tarea al pulsarla.
 * Hasta entonces «espera a otra» era texto en un comentario.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

const tarjeta = (detalle: Record<string, unknown>) => ({
  task: {
    id: "t-1", seq: 8, title: "Pendiente", description: "",
    priority: "normal", status: "pending", listId: "li-1", orgId: "o-1",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  attachments: [], comments: [], subtasks: [], tags: [], assignees: [],
  listName: "tasks", spaceName: "cac", ref: "cc-8",
  status: { id: "li-1/pending", name: "Open", kind: "open", color: "#888", listId: "li-1" },
  ...detalle,
});

vi.mock("@/lib/media", () => ({
  isPdfAttachment: () => false, linkClickAction: () => "edit", mediaSrc: (u?: string) => u,
  openAttachment: vi.fn(), attachmentPath: (u?: string) => u ?? null,
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) => sel(estado.current),
}));
vi.mock("@/store/auth.store", () => {
  const estadoAuth = { session: { id: "u-1" }, accessToken: "t" };
  return {
    useAuthStore: Object.assign((sel: (s: typeof estadoAuth) => unknown) => sel(estadoAuth), {
      getState: () => estadoAuth, subscribe: () => () => {},
    }),
  };
});
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));
vi.mock("@/components/UserPicker", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/PromptDialog", () => ({ usePrompt: () => async () => "" }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { useOrgsStore } = await import("@/store/orgs.store");
beforeEach(() => useOrgsStore.setState({ currentOrgId: "o-1" }));

const openTask = vi.fn(async () => {});
const montar = (detalle: Record<string, unknown>) => {
  estado.current = {
    openTaskId: "t-1", detail: tarjeta(detalle), loadingDetail: false, detailError: null,
    closeTask: () => {}, updateTask: vi.fn(), deleteTask: vi.fn(), addComment: vi.fn(),
    editComment: vi.fn(), deleteComment: vi.fn(), uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(), createTag: vi.fn(), tags: [], statusesOf: async () => [],
    createSubtask: vi.fn(), openTask, refreshOpenTask: vi.fn(), tree: [],
  };
  return render(<TaskDetailDrawer />);
};

beforeEach(() => { cleanup(); openTask.mockClear(); });
afterEach(cleanup);

describe("a qué espera una tarea", () => {
  it("enseña cada dependencia por su referencia, tachada si ya está hecha, y la abre al pulsar", () => {
    montar({ blockedBy: [
      { id: "b-1", ref: "cc-7", title: "En curso", status: "in_progress", open: true },
      { id: "b-2", ref: "cc-3", title: "Hecha", status: "resolved", open: false },
    ] });
    const zona = screen.getByTestId("blocked-by");
    const botones = zona.querySelectorAll("button");
    expect(botones.length).toBe(2);
    expect(botones[0].getAttribute("data-open")).toBe("true");
    expect(botones[0].textContent).toBe("cc-7");
    expect(botones[1].getAttribute("data-open")).toBe("false");
    expect(botones[1].textContent).toMatch(/cc-3 · (hecha|done)/);
    fireEvent.click(botones[0]);
    expect(openTask).toHaveBeenCalledWith("b-1");
  });

  it("sin dependencias no enseña la sección", () => {
    montar({ blockedBy: [] });
    expect(screen.queryByTestId("blocked-by")).toBeNull();
  });
});
