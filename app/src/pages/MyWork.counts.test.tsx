import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { OpenTask } from "@/types/task";

/**
 * Los números tienen que querer decir lo mismo en las dos pantallas.
 *
 * El árbol contaba **todas** las tareas vivas de una lista y «Mi trabajo»
 * enseña las abiertas, así que la misma lista decía 9 en un sitio y 1 en el de
 * al lado sin que nada explicara la diferencia. Y el tablero remataba con una
 * columna «Done · 0», que no es que no hubiera ninguna: es que con «sólo
 * abiertas» ni se piden.
 */

const { estado } = vi.hoisted(() => ({
  estado: { current: { tasks: [] as OpenTask[], includeClosed: false } },
}));

vi.mock("@/store/mywork.store", () => ({
  useMyWorkStore: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) => {
      const s = {
        lens: "all", scope: null, tasks: estado.current.tasks, loading: false, error: null,
        includeClosed: estado.current.includeClosed,
        setLens: vi.fn(), setScope: vi.fn(), setIncludeClosed: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined), setWatching: vi.fn(),
      };
      return sel ? sel(s) : s;
    },
    { getState: () => estado.current },
  ),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-1" }),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ tree: [], openTask: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { default: MyWork } = await import("@/pages/MyWork");

afterEach(cleanup);

const tarea = (id: string, status: string): OpenTask =>
  ({
    id, seq: 1, title: id, priority: "normal", status, statusName: status,
    statusKind: status === "closed" || status === "done" ? "done" : status === "in_progress" ? "active" : "open",
    listId: "li-1", listName: "tasks", spaceId: "sp-1", spaceName: "uno",
    updatedAt: new Date().toISOString(), subtasksDone: 0, subtaskCount: 0,
  }) as unknown as OpenTask;

const enTablero = (tasks: OpenTask[], includeClosed: boolean) => {
  estado.current = { tasks, includeClosed };
  render(
    <MemoryRouter>
      <MyWork />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByTitle("Board"));
};

describe("las cuentas del tablero de Mi trabajo", () => {
  it("con «sólo abiertas», Done y Closed no afirman que no haya ninguna", () => {
    enTablero([tarea("t1", "open")], false);
    // Dos columnas fuera de la pregunta: terminadas y cerradas.
    expect(screen.getAllByText("Not asked for — showing open only")).toHaveLength(2);
  });

  it("pidiéndolas todas, Done y Closed vuelven a contar de verdad", () => {
    enTablero([tarea("t1", "open"), tarea("t2", "done"), tarea("t3", "closed")], true);
    expect(screen.queryByText("Not asked for — showing open only")).toBeNull();
    expect(screen.getByText("t2")).toBeTruthy();
    expect(screen.getByText("t3")).toBeTruthy();
  });

  it("cerrada no se esconde dentro de «terminadas»", () => {
    enTablero([tarea("t2", "done"), tarea("t3", "closed")], true);
    // Cada columna con la suya: la clase las juntaba a las dos bajo «done», y
    // una tarea cerrada —que es como llegan por la integración
    // server-to-server— desaparecía dentro de las terminadas.
    const columnas = screen.getAllByRole("heading", { level: 2 });
    const cerrada = columnas.find((h) => h.textContent?.includes("Closed"))!;
    expect(cerrada.textContent).toContain("1");
    const terminada = columnas.find((h) => h.textContent?.startsWith("Done"))!;
    expect(terminada.textContent).toContain("1");
  });

  it("un servidor que aún dice «resolved» cae igual en Done", () => {
    enTablero([tarea("t9", "resolved")], true);
    const cabecera = screen
      .getAllByRole("heading", { level: 2 })
      .find((h) => h.textContent?.startsWith("Done"))!;
    expect(cabecera.textContent).toContain("1");
  });
});
