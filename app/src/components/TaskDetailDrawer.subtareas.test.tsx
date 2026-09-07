import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Marcar una subtarea como hecha.
 *
 * El check elegía «la primera columna de tipo done» sin preguntar si se podía
 * llegar. Desde Open eso es `resolved`, y esa transición **no existe** en la
 * máquina que protege a un cliente: el servidor contestaba 409 y el check no
 * hacía nada, en las dos direcciones. El tablero sí consultaba la regla; este
 * botón no sabía que existía.
 *
 * Con dos máquinas la respuesta depende de la ficha, y eso es lo que se prueba:
 * una subtarea interna va directa a Done, y una que un cliente ve pasa por In
 * progress — que no es un rodeo, es la regla que protege lo que él tiene delante.
 */

const moveTask = vi.fn(async () => {});

const COLUMNAS = [
  { id: "l1/pending", name: "Open", kind: "open", status: "pending" },
  { id: "l1/in_progress", name: "In progress", kind: "active", status: "in_progress" },
  { id: "l1/resolved", name: "Done", kind: "done", status: "resolved" },
  { id: "l1/closed", name: "Closed", kind: "done", status: "closed" },
];

const CLIENTE = {
  pending: ["in_progress", "closed"],
  in_progress: ["pending", "resolved", "closed"],
  resolved: ["in_progress", "closed"],
  closed: [],
};
const INTERNA = {
  pending: ["in_progress", "resolved", "closed"],
  in_progress: ["pending", "resolved", "closed"],
  resolved: ["pending", "in_progress", "closed"],
  closed: ["pending", "in_progress", "resolved"],
};

const detalle = { current: {} as Record<string, unknown> };

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: COLUMNAS })), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: () => "",
}));
vi.mock("@/store/reports.store", () => ({
  useReportsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ transitions: CLIENTE, internalTransitions: INTERNA }),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        detail: detalle.current, openTaskId: "t1", moveTask,
        closeTask: vi.fn(), updateTask: vi.fn(), addComment: vi.fn(),
        createSubtask: vi.fn(), openTask: vi.fn(), deleteAttachment: vi.fn(),
        uploadTaskAttachment: vi.fn(), tags: [], statusesOf: vi.fn(async () => COLUMNAS),
        editComment: vi.fn(), deleteComment: vi.fn(), refreshOpenTask: vi.fn(),
        setTaskTags: vi.fn(), assign: vi.fn(),
      }),
    { getState: () => ({ statusesOf: vi.fn(async () => COLUMNAS) }) },
  ),
}));

const { default: Drawer } = await import("@/components/TaskDetailDrawer");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

/** El panel usa los diálogos imperativos, que viven en un proveedor. */
const montar = () =>
  render(
    <ConfirmProvider>
      <PromptProvider>
        <Drawer />
      </PromptProvider>
    </ConfirmProvider>,
  );

afterEach(() => {
  cleanup();
  moveTask.mockClear();
});

const conSubtarea = (flow: string) => ({
  task: {
    id: "t1", listId: "l1", seq: 1, title: "padre", description: "",
    statusId: "l1/pending", priority: "normal", orgId: "o1", spaceId: "s1",
    status: "pending", visibility: "internal", projectId: "",
    createdAt: "", updatedAt: "",
  },
  listName: "tasks", spaceName: "cac",
  status: COLUMNAS[0], tags: [], assignees: [], comments: [], attachments: [],
  subtasks: [
    { id: "sub1", seq: 2, title: "una subtarea", statusId: "l1/pending", flow, tags: [], assignees: [] },
  ],
});

describe("el check de una subtarea abierta", () => {
  /**
   * Salta directa a Done, sin pasar por In progress.
   *
   * Es legal porque una subtarea **siempre** es interna: el servidor le borra el
   * proyecto al crearla, para no gastar un folio del cliente en una línea de
   * checklist. Con la máquina del cliente aplicada a todo, esa transición no
   * existía y el botón no hacía nada.
   */
  it("va directa a Done", async () => {
    detalle.current = conSubtarea("internal");
    montar();
    fireEvent.click(await screen.findByTitle("Mark complete"));
    expect(moveTask).toHaveBeenCalledWith("sub1", "l1/resolved", "", "");
  });

});
