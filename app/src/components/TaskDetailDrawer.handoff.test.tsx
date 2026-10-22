import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El «dónde quedó» de una tarea se ve antes que la descripción, con quién lo
 * escribió, y se reemplaza entero (22-oct-2026).
 *
 * Hasta entonces lo que la siguiente sesión necesitaba —qué está hecho, el
 * siguiente paso, cómo comprobar si salió— vivía en el hilo, entre los avisos
 * de commit, o en la memoria local de un agente, donde nadie más lo leía.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

const tarjeta = (extra: Record<string, unknown>, detalle: Record<string, unknown> = {}) => ({
  task: {
    id: "t-1", seq: 203, title: "Claves de espacio", description: "La descripción de siempre",
    priority: "normal", status: "in_progress", listId: "li-1", orgId: "o-1",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...extra,
  },
  attachments: [], comments: [], subtasks: [], tags: [], assignees: [],
  listName: "tasks", spaceName: "Command and control", ref: "command-and-control-203",
  status: { id: "li-1/in_progress", name: "In progress", kind: "active", color: "#888", listId: "li-1" },
  ...detalle,
});

vi.mock("@/lib/media", () => ({
  isPdfAttachment: () => false,
  linkClickAction: () => "edit",
  mediaSrc: (u?: string) => u,
  openAttachment: vi.fn(),
  attachmentPath: (u?: string) => u ?? null,
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) => sel(estado.current),
}));
vi.mock("@/store/auth.store", () => {
  const estadoAuth = { session: { id: "u-1" }, accessToken: "t" };
  return {
    useAuthStore: Object.assign((sel: (s: typeof estadoAuth) => unknown) => sel(estadoAuth), {
      getState: () => estadoAuth,
      subscribe: () => () => {},
    }),
  };
});
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
// El markdown se pinta como texto plano: lo que se comprueba es qué texto llega.
vi.mock("@/components/markdown/Markdown", () => ({ default: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock("@/components/UserPicker", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/PromptDialog", () => ({ usePrompt: () => async () => "" }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { useOrgsStore } = await import("@/store/orgs.store");
beforeEach(() => useOrgsStore.setState({ currentOrgId: "o-1" }));

const updateTask = vi.fn(async () => {});
const montar = (extra: Record<string, unknown>, detalle: Record<string, unknown> = {}) => {
  estado.current = {
    openTaskId: "t-1", detail: tarjeta(extra, detalle), loadingDetail: false, detailError: null,
    closeTask: () => {}, updateTask, deleteTask: vi.fn(), addComment: vi.fn(),
    editComment: vi.fn(), deleteComment: vi.fn(), uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(), createTag: vi.fn(), tags: [], statusesOf: async () => [],
    createSubtask: vi.fn(), openTask: vi.fn(), refreshOpenTask: vi.fn(), tree: [],
  };
  return render(<TaskDetailDrawer />);
};

beforeEach(() => {
  cleanup();
  updateTask.mockClear();
});
afterEach(cleanup);

describe("el dónde quedó de una tarea", () => {
  it("se lee antes que la descripción, con quién lo escribió", () => {
    montar(
      { handoff: "Falta la release. Siguiente: probarlo.", handoffAt: "2026-10-22T08:00:00Z" },
      { handoffBy: "jose" },
    );
    const handoff = screen.getByTestId("handoff");
    expect(handoff.textContent).toContain("Falta la release. Siguiente: probarlo.");
    expect(handoff.textContent).toContain("jose");
    // Antes que la descripción: en el DOM va primero.
    const descripcion = screen.getByText("La descripción de siempre");
    expect(handoff.compareDocumentPosition(descripcion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sin nada escrito lo dice, y ofrece escribirlo", () => {
    montar({});
    expect(screen.getByTestId("handoff").textContent).toMatch(/nobody has written|nadie ha dejado/i);
    expect(screen.getByRole("button", { name: /write where it was left|escribir dónde quedó/i })).toBeTruthy();
  });

  it("se guarda entero, reemplazando lo que había", () => {
    montar({ handoff: "Lo viejo", handoffAt: "2026-10-22T08:00:00Z" }, { handoffBy: "jose" });
    fireEvent.click(screen.getAllByRole("button", { name: /^edit$|^editar$/i })[0]);
    const area = screen.getByPlaceholderText(/what is done|qué está hecho/i);
    fireEvent.change(area, { target: { value: "  Lo nuevo  " } });
    fireEvent.click(screen.getByRole("button", { name: /^save$|^guardar$/i }));
    expect(updateTask).toHaveBeenCalledWith("t-1", { handoff: "Lo nuevo" });
  });
});
