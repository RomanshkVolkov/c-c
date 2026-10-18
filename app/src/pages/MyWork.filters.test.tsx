import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OpenTask } from "@/types/task";

/**
 * El buscador de «Mi trabajo», que es donde se aterriza al pulsar una lista en
 * el árbol: filtra lo que se ve, y es del ámbito en que se puso.
 */

vi.mock("@/lib/api", () => ({
  // Lo que pide la pantalla al montarse no llega: las tareas las pone la prueba.
  api: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/tasks/NewTaskRow", () => ({ default: () => null }));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { MemoryRouter } = await import("react-router-dom");
const { default: MyWork } = await import("@/pages/MyWork");
const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const task = (id: string, seq: number, title: string, listId: string, assignee?: string): OpenTask =>
  ({
    id, seq, title, priority: "normal", status: "pending", statusName: "Open", statusKind: "open",
    listId, listName: "tasks", spaceId: "sp-1", spaceName: "Boaty", updatedAt: "", subtasksDone: 0,
    subtasksTotal: 0, assignee,
  }) as OpenTask;

beforeEach(() => {
  useTasksStore.setState({ tree: [] } as never);
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useMyWorkStore.setState({
    tasks: [
      task("t1", 26, "GitHub Actions bloqueado", "l-1", "ana"),
      task("t2", 29, "Subida a producción", "l-1", "beto"),
      task("t3", 5, "Otra lista", "l-2"),
    ],
    scope: { kind: "list", id: "l-1", name: "tasks", orgId: "org-1" },
    loading: false,
    error: null,
    vista: "list",
  } as never);
});
afterEach(cleanup);

const mount = () =>
  render(
    <MemoryRouter>
      <MyWork />
    </MemoryRouter>,
  );

/**
 * Entrar con lo que ya hay no pide nada: los eventos lo mantienen al día.
 * El mutante que mata: volver a `load` en el montaje.
 */
describe("entrar en Mi trabajo", () => {
  it("con las tareas ya cargadas para esa pregunta, no las vuelve a pedir", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockClear();
    useMyWorkStore.setState({ lens: "all", includeClosed: false, loadedKey: "org-1|all|false" } as never);
    mount();
    expect(vi.mocked(api.get).mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith("/api/v1/tasks/?"))).toEqual([]);
  });
});

describe("buscar en Mi trabajo", () => {
  it("filtra lo que se ve, dentro de la lista acotada", () => {
    mount();
    expect(screen.getByText("GitHub Actions bloqueado")).toBeTruthy();
    expect(screen.queryByText("Otra lista")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "#29" } });
    expect(screen.getByText("Subida a producción")).toBeTruthy();
    expect(screen.queryByText("GitHub Actions bloqueado")).toBeNull();
  });

  it("por responsable, con su nombre", () => {
    mount();
    expect(screen.getByRole("combobox", { name: "Any assignee" })).toBeTruthy();
  });

  it("si no queda ninguna, lo dice", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nada de esto" } });
    expect(screen.getByText("No task matches the filter.")).toBeTruthy();
  });

  /** Una búsqueda olvidada no se arrastra a otra lista pulsada en el árbol. */
  it("al cambiar de lista, el filtro vuelve a vacío", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "github" } });
    act(() => {
      useMyWorkStore.setState({ scope: { kind: "list", id: "l-2", name: "otra", orgId: "org-1" } } as never);
    });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Otra lista")).toBeTruthy();
  });
});
