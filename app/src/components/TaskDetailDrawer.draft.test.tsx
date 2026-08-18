import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

/**
 * The second half of the draft-loss fix, and the one that isn't in the store.
 *
 * Even with `detail` never blanked, the drawer used to overwrite the field with
 * the server's copy: its resync effect depended on `task.description`, so any
 * refetch of the *same* task — a comment, an attachment, someone else's edit —
 * replaced what was being typed. It resyncs on `task.id` alone now, and this is
 * what says so.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));
vi.mock("@/store/orgs.store", () => ({ useOrgsStore: { getState: () => ({ currentOrgId: "org" }) } }));
// The editor is Tiptap over a contenteditable; the draft lives in the drawer's
// own state, so a textarea stands in for it and keeps this about the effect.
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="draft" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("@/components/markdown/Markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const { useTasksStore } = await import("@/store/tasks.store");
const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

const detail = (id: string, description: string, title = "Una tarea") =>
  ({
    task: {
      id, title, description, orgId: "org", listId: "list-1", statusId: "st-1",
      seq: 1, priority: "none", createdById: "u1", createdAt: "", updatedAt: "",
    },
    listName: "L", spaceName: "S",
    status: { id: "st-1", listId: "list-1", name: "Open", color: "", kind: "open" },
    tags: [], assignees: [], comments: [], attachments: [], subtasks: [],
  }) as never;

/**
 * The description editor, not the comment composer — both are the same
 * component, so they have to be told apart by where they sit.
 */
const descriptionField = () => {
  const section = screen.getByText("Description").closest("section")!;
  return within(section).getByTestId("draft") as HTMLTextAreaElement;
};

/** React tracks the value internally; a plain assignment wouldn't fire onChange. */
const type = async (field: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const renderDrawer = () =>
  render(
    <ConfirmProvider>
      <PromptProvider>
        <TaskDetailDrawer />
      </PromptProvider>
    </ConfirmProvider>,
  );

// Explicit, because auto-cleanup only registers when vitest runs with globals.
// Without it the second test mounts a drawer on top of the first one's.
afterEach(cleanup);

beforeEach(() => {
  useTasksStore.setState({
    openTaskId: "task-1",
    detail: detail("task-1", "lo del servidor"),
    activeListId: "list-1",
    board: { list: { id: "list-1", name: "L", taskCount: 1 }, statuses: [], tasks: [] } as never,
    tags: [],
    loadingDetail: false,
  });
});

describe("la descripción a medio escribir", () => {
  it("sobrevive a que se recargue la misma tarea", async () => {
    renderDrawer();
    await act(async () => { screen.getByText("Edit").click(); });

    await type(descriptionField(), "un párrafo a medio escribir");
    expect(descriptionField().value).toBe("un párrafo a medio escribir");

    // What a refresh looks like from here: same task id, server's copy of the
    // body. This is the moment the draft used to disappear.
    await act(async () => {
      useTasksStore.setState({ detail: detail("task-1", "lo del servidor, cambiado") });
    });

    expect(descriptionField().value).toBe("un párrafo a medio escribir");
  });

  it("se descarta al cambiar a otra tarea, que es lo que sí debe pasar", async () => {
    renderDrawer();
    await act(async () => { screen.getByText("Edit").click(); });

    await type(descriptionField(), "borrador de la primera");

    await act(async () => {
      useTasksStore.setState({ openTaskId: "task-2", detail: detail("task-2", "otra cosa") });
    });

    // Back to read mode on the new task: the draft belonged to the one we left.
    const section = screen.getByText("Description").closest("section")!;
    expect(within(section).queryByTestId("draft")).toBeNull();
    expect(within(section).getByText("otra cosa")).toBeTruthy();
  });
});
