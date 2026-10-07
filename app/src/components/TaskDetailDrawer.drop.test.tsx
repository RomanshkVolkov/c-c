import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";

/**
 * Las zonas para soltar de una tarea, como en canales y directos (jose,
 * 7-oct-2026): lo soltado sobre la descripción va a la descripción —y si no se
 * estaba editando, entra en edición—; lo soltado sobre los comentarios, al
 * comentario nuevo. Mutantes: no entrar en edición; mandar a la descripción lo
 * de los comentarios; no meter lo pendiente al abrir el editor.
 */
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) => {
      const st = { currentOrgId: "org" };
      return sel ? sel(st) : st;
    },
    { getState: () => ({ currentOrgId: "org" }) },
  ),
}));
// Cada editor apunta lo que le llega por insertFiles, con el texto que tiene
// (la descripción lleva el de la tarea; el comentario, vacío).
const recibido: { editor: string; names: string[] }[] = [];
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: forwardRef(function Falso({ value }: { value: string }, ref) {
    useImperativeHandle(ref, () => ({
      insertLink: () => {},
      insertFiles: (fs: File[]) => recibido.push({ editor: value === "" ? "comentario" : "descripcion", names: fs.map((f) => f.name) }),
    }));
    return <textarea data-testid="editor" value={value} readOnly />;
  }),
}));
vi.mock("@/components/markdown/Markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const { useTasksStore } = await import("@/store/tasks.store");
const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

const detail = {
  task: {
    id: "task-1", title: "Una tarea", description: "lo de la tarea", orgId: "org", listId: "list-1",
    statusId: "st-1", seq: 1, priority: "none", createdById: "u1", createdAt: "", updatedAt: "",
  },
  listName: "L", spaceName: "S",
  status: { id: "st-1", listId: "list-1", name: "Open", color: "", kind: "open" },
  tags: [], assignees: [], comments: [], attachments: [], subtasks: [],
} as never;

afterEach(() => {
  cleanup();
  recibido.length = 0;
});
beforeEach(() => {
  useTasksStore.setState({
    openTaskId: "task-1", detail, activeListId: "list-1",
    board: { list: { id: "list-1", name: "L", taskCount: 1 }, statuses: [], tasks: [] } as never,
    tags: [], loadingDetail: false,
  });
});

const soltar = async (dentro: Element, name: string) => {
  const f = new File(["x"], name, { type: "image/png" });
  const dt = { types: ["Files"], files: [f], items: [], dropEffect: "none", getData: () => "" };
  await act(async () => {
    fireEvent.dragEnter(dentro, { dataTransfer: dt });
    fireEvent.drop(dentro, { dataTransfer: dt });
  });
};

describe("soltar en una tarea", () => {
  it("sobre la descripción: entra en edición y va a la descripción", async () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <TaskDetailDrawer />
        </PromptProvider>
      </ConfirmProvider>,
    );
    const descripcion = screen.getByText("lo de la tarea").closest("section")!;
    await soltar(descripcion, "captura.png");
    await waitFor(() => expect(recibido).toEqual([{ editor: "descripcion", names: ["captura.png"] }]));
    expect(within(screen.getByText("Description").closest("section")!).getByTestId("editor")).toBeTruthy();
  });

  it("sobre los comentarios: va al comentario nuevo", async () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <TaskDetailDrawer />
        </PromptProvider>
      </ConfirmProvider>,
    );
    const comentarios = screen.getByText(/Activity/).closest("section")!;
    await soltar(comentarios, "log.png");
    await waitFor(() => expect(recibido).toEqual([{ editor: "comentario", names: ["log.png"] }]));
  });
});
