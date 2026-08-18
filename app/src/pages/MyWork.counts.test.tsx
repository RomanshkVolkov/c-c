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

const tarea = (id: string, kind: string): OpenTask =>
  ({
    id, seq: 1, title: id, priority: "normal", statusName: kind, statusKind: kind,
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
  it("con «sólo abiertas», Done no afirma que no haya ninguna", () => {
    enTablero([tarea("t1", "open")], false);
    expect(screen.getByText("Not asked for — showing open only")).toBeTruthy();
    // Y su cuenta no es «0», que sería afirmar que no queda nada terminado.
    expect(screen.queryByText("Nothing")).toBeTruthy(); // las otras dos sí están vacías
  });

  it("pidiéndolas todas, Done vuelve a contar de verdad", () => {
    enTablero([tarea("t1", "open"), tarea("t2", "done")], true);
    expect(screen.queryByText("Not asked for — showing open only")).toBeNull();
    expect(screen.getByText("t2")).toBeTruthy();
  });
});
