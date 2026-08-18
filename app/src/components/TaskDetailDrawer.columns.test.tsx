import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * The detail must offer the columns of the task's own list.
 *
 * It read `board.statuses` — the columns of whichever board happened to be
 * open. Opened from "my work", from a notification or from search there is no
 * board, so the status menu came up with nothing in it: a control that looked
 * like a label and did nothing. Ticking a subtask silently did nothing too,
 * for the same reason.
 */

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { useTasksStore } = await import("@/store/tasks.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const detalle = {
  task: {
    id: "t-1", seq: 7, title: "Una tarea", listId: "li-otra", orgId: "org-1",
    priority: "normal", statusId: "s-open", visibility: "internal", description: "",
  },
  status: { id: "s-open", name: "To do", color: "#888", kind: "open" },
  spaceName: "Uno", listName: "Otra", tags: [], assignees: [], comments: [],
  attachments: [], subtasks: [], backlinks: [],
};

beforeEach(() => {
  get.mockResolvedValue({
    success: true,
    data: [
      { id: "s-open", name: "To do", color: "#888", kind: "open", listId: "li-otra" },
      { id: "s-done", name: "Done", color: "#0f0", kind: "done", listId: "li-otra" },
    ],
  });
  useTasksStore.setState({
    openTaskId: "t-1",
    detail: detalle,
    loadingDetail: false,
    // Hay un tablero abierto, y es de OTRA lista. Sin esto las dos fuentes dan
    // el mismo id y el test no puede distinguirlas — que es como se me coló la
    // primera versión de esta comprobación.
    board: { list: { id: "li-abierta", name: "Abierta" }, statuses: [], tasks: [] },
    activeListId: "li-abierta",
  } as never);
});
afterEach(() => {
  get.mockReset();
  cleanup();
});

describe("las columnas del detalle", () => {
  it("se piden a la lista de la tarea, no al tablero abierto", async () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <TaskDetailDrawer />
        </PromptProvider>
      </ConfirmProvider>,
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    // La lista de la tarea, no la que estuviera activa.
    expect(String(get.mock.calls[0][0])).toContain("/task-lists/li-otra/statuses");
    // El título vive en un input, no como texto: la pantalla se montó.
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("input")).some(
          (i) => (i as HTMLInputElement).value === "Una tarea",
        ),
      ).toBe(true),
    );
  });
});
