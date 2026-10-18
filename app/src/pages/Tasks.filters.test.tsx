import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * El buscador de una lista: filtra lo que se ve, dice cuántas quedan, y es de
 * la lista en la que se puso — al cambiar de lista no se arrastra.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { default: Tasks } = await import("./Tasks");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const card = (id: string, seq: number, title: string) => ({
  id,
  seq,
  title,
  priority: "none",
  statusId: "st-1",
  hasDescription: false,
  commentCount: 0,
  attachmentCount: 0,
  subtaskCount: 0,
  subtaskDone: 0,
  tags: [],
  assignees: [],
  updatedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-10-01T00:00:00Z",
});
const boardOf = (listId: string, name: string, tasks: ReturnType<typeof card>[]) => ({
  list: { id: listId, name },
  statuses: [{ id: "st-1", name: "Open", color: "#888", status: "open" }],
  tasks,
});

beforeEach(() => {
  // El tablero lo pone la prueba; lo que pida la pantalla al montarse no llega.
  api.get.mockReturnValue(new Promise(() => {}));
  useOrgsStore.setState({ currentOrgId: "org-1" });
  useTasksStore.setState({
    activeDoc: null,
    activeListId: "li-1",
    boardView: "list",
    board: boardOf("li-1", "Apps", [card("t1", 1, "Revisión del backup"), card("t2", 12, "Logo nuevo")]),
  } as never);
});
afterEach(cleanup);

const screenOf = () =>
  render(
    <ConfirmProvider>
      <PromptProvider>
        <MemoryRouter initialEntries={["/tasks"]}>
          <Tasks />
        </MemoryRouter>
      </PromptProvider>
    </ConfirmProvider>,
  );
const search = () => screen.getByRole("searchbox") as HTMLInputElement;

describe("buscar en una lista", () => {
  it("deja sólo las que coinciden y dice cuántas de cuántas", () => {
    screenOf();
    expect(screen.getByText("2 tasks")).toBeTruthy();
    fireEvent.change(search(), { target: { value: "revision" } });
    expect(screen.getByText("Revisión del backup")).toBeTruthy();
    expect(screen.queryByText("Logo nuevo")).toBeNull();
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("si no queda ninguna, lo dice en vez de enseñar una lista vacía", () => {
    screenOf();
    fireEvent.change(search(), { target: { value: "nada de esto" } });
    expect(screen.getByText("No task matches the filter.")).toBeTruthy();
  });

  it("Escape vacía la búsqueda", () => {
    screenOf();
    fireEvent.change(search(), { target: { value: "logo" } });
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect(screen.getByText("Revisión del backup")).toBeTruthy();
  });

  /**
   * Una búsqueda olvidada no se arrastra a otra lista: la dejaría en blanco
   * sin decir por qué. El mutante que mata: guardar el filtro sin su lista.
   */
  it("al cambiar de lista, el filtro vuelve a vacío", () => {
    screenOf();
    fireEvent.change(search(), { target: { value: "revision" } });
    act(() => {
      useTasksStore.setState({
        activeListId: "li-2",
        board: boardOf("li-2", "Web", [card("t3", 1, "Portada")]),
      } as never);
    });
    expect(search().value).toBe("");
    expect(screen.getByText("Portada")).toBeTruthy();
  });

  /** Las columnas del tablero de una lista, en el color de su estado. */
  it("en el tablero, cada columna lleva el color de su estado", () => {
    useTasksStore.setState({ boardView: "board" } as never);
    screenOf();
    expect(screen.getByText("Open").closest("section")!.className).toContain("border-t-status-open");
  });

  it("la cabecera es la de la documentación: nombre e id, sin la cuenta", () => {
    screenOf();
    expect(screen.getByRole("heading", { name: "Apps" })).toBeTruthy();
    // La cuenta vive en la fila de los filtros; en la cabecera no se repite.
    expect(screen.getAllByText("2 tasks")).toHaveLength(1);
  });
});
