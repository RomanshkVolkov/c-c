import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * Una tarea de otra org no se pinta en ésta.
 *
 * El cajón está montado en toda la app y sobrevivía a cambiar de org si se
 * había abierto desde «Mi trabajo», un aviso o el buscador. Lo cierra
 * `store/org-switch.ts`; esto es lo que garantiza que no se vea aunque algo lo
 * deje abierto.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const detalle = (orgId: string) => ({
  task: {
    id: "t-1", seq: 7, title: "Una tarea", listId: "li-1", orgId,
    priority: "normal", statusId: "s-open", visibility: "internal", description: "",
  },
  status: { id: "s-open", name: "Open", color: "#888", kind: "open" },
  spaceName: "Uno", listName: "Lista", tags: [], assignees: [], comments: [],
  attachments: [], subtasks: [], backlinks: [],
});

const montar = () =>
  render(
    <ConfirmProvider>
      <PromptProvider>
        <TaskDetailDrawer />
      </PromptProvider>
    </ConfirmProvider>,
  );

beforeEach(() => useOrgsStore.setState({ currentOrgId: "org-b" }));
afterEach(cleanup);

describe("el cajón de tarea y la org en pantalla", () => {
  it("una tarea de otra org no se pinta", () => {
    useTasksStore.setState({ openTaskId: "t-1", detail: detalle("org-a"), loadingDetail: false } as never);
    const { container } = montar();
    expect(container.querySelector("aside")).toBeNull();
  });

  it("una de esta org, sí", () => {
    useTasksStore.setState({ openTaskId: "t-1", detail: detalle("org-b"), loadingDetail: false } as never);
    const { container } = montar();
    expect(container.querySelector("aside")).not.toBeNull();
  });
});
