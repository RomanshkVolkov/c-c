import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { OpenTask } from "@/types/task";

/**
 * Arrastrar una tarjeta en «Mi trabajo» cambia su estado **en su propia lista**.
 *
 * Las columnas de esta pantalla son transversales: las tarjetas vienen de
 * listas distintas y «Done» no es la columna de ningún tablero concreto. Por
 * eso mover no puede ser «ponla en la columna Done» sino «busca la columna
 * equivalente de *su* lista».
 *
 * El arrastre en sí lo prueba `@dnd-kit`, no nosotros. Lo que se prueba aquí es
 * la decisión: **a qué id se mueve**. Es donde estaba el riesgo — componer
 * `<listId>/<estado>` a mano en el cliente habría sido copiar una regla del
 * servidor, y `kind` no vale para elegir porque «Done» y «Closed» son las dos
 * `done`.
 */

const { estado, statusesOf, moveTask, load } = vi.hoisted(() => ({
  estado: { current: { tasks: [] as OpenTask[], includeClosed: true } },
  statusesOf: vi.fn(),
  moveTask: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/store/mywork.store", () => ({
  useMyWorkStore: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) => {
      const s = {
        lens: "all", scope: null, tasks: estado.current.tasks, loading: false, error: null,
        includeClosed: estado.current.includeClosed,
        setLens: vi.fn(), setScope: vi.fn(), setIncludeClosed: vi.fn(),
        load, setWatching: vi.fn(),
      };
      return sel ? sel(s) : s;
    },
    { getState: () => estado.current },
  ),
}));
// El mapa de transiciones que la pantalla consulta ahora para saber qué
// columnas puede ofrecer. Llega ya plegado al vocabulario de la app, que es lo
// que hace `fetchTransitions`.
vi.mock("@/store/reports.store", () => ({
  useReportsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      transitions: {
        open: ["in_progress", "closed"],
        in_progress: ["open", "done", "closed"],
        done: ["in_progress", "closed"],
        closed: [],
      },
      fetchTransitions: vi.fn().mockResolvedValue(undefined),
    }),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-1" }),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ tree: [], openTask: vi.fn().mockResolvedValue(undefined), statusesOf, moveTask }),
}));

// El tablero se sustituye por un doble que sólo guarda su `onMove`: es lo que
// se quiere disparar, y simular un arrastre de verdad probaría a dnd-kit.
const { onMove, puedeSoltar } = vi.hoisted(() => ({
  onMove: { fn: null as null | ((m: { itemId: string; toColumnId: string }) => void) },
  // Y el predicado, que es lo que decide si una columna se ofrece o se pinta en
  // rojo. Se captura igual que `onMove`: probar el rojo de verdad sería probar
  // a dnd-kit, y lo que importa es la decisión.
  puedeSoltar: { fn: null as null | ((t: OpenTask, c: string) => boolean) },
}));
vi.mock("@/components/kanban/KanbanBoard", () => ({
  default: (props: {
    onMove: (m: { itemId: string; toColumnId: string }) => void;
    puedeSoltar?: (t: OpenTask, c: string) => boolean;
  }) => {
    onMove.fn = props.onMove;
    puedeSoltar.fn = props.puedeSoltar ?? null;
    return null;
  },
}));

const { default: MyWork } = await import("./MyWork");

const tarea = (id: string, status: string, listId: string): OpenTask =>
  ({
    id, seq: 1, title: id, priority: "normal", status, statusName: status,
    statusKind: "open", listId, listName: "tasks", spaceId: "e-1", spaceName: "Space",
  }) as OpenTask;

const columnasDe = (listId: string) => [
  { id: `${listId}/pending`, listId, name: "Open", color: "", kind: "open", status: "pending" },
  { id: `${listId}/in_progress`, listId, name: "In progress", color: "", kind: "active", status: "in_progress" },
  { id: `${listId}/resolved`, listId, name: "Done", color: "", kind: "done", status: "resolved" },
  { id: `${listId}/closed`, listId, name: "Closed", color: "", kind: "done", status: "closed" },
];

const montar = (tasks: OpenTask[]) => {
  estado.current = { tasks, includeClosed: true };
  render(
    <MemoryRouter>
      <MyWork />
    </MemoryRouter>,
  );
  // La vista arranca en lista; el tablero es el que tiene arrastre.
  fireEvent.click(screen.getByTitle("Board"));
};

// Todo se rearma aquí y no al declararlo: `restoreMocks: true` en la config de
// vitest deja los `vi.fn()` sin implementación antes de cada test, así que un
// `mockResolvedValue` puesto arriba devuelve `undefined` cuando llega el turno.
beforeEach(() => {
  onMove.fn = null;
  load.mockResolvedValue(undefined);
  moveTask.mockResolvedValue(undefined);
  statusesOf.mockImplementation((listId: string) => Promise.resolve(columnasDe(listId)));
});
afterEach(cleanup);

describe("arrastrar en Mi trabajo", () => {
  // Con «in_progress» y no «done» a propósito: desde «open», «done» ya no es un
  // destino que el tablero ofrezca, y una prueba que mueve donde la interfaz no
  // deja describe algo que no puede pasar.
  it("mueve a la columna equivalente de la lista de esa tarea", async () => {
    montar([tarea("t1", "pending", "lista-de-otro-espacio")]);
    await onMove.fn!({ itemId: "t1", toColumnId: "in_progress" });

    // La lista se le pregunta al servidor y el id sale de su respuesta.
    expect(statusesOf).toHaveBeenCalledWith("lista-de-otro-espacio");
    expect(moveTask).toHaveBeenCalledWith("t1", "lista-de-otro-espacio/in_progress", "", "");
  });

  it("distingue «Done» de «Closed», que por clase son la misma", async () => {
    montar([tarea("t1", "pending", "l-1")]);
    await onMove.fn!({ itemId: "t1", toColumnId: "closed" });
    // Las dos columnas son `kind: "done"`. Elegir por clase habría mandado la
    // tarjeta a la primera de las dos.
    expect(moveTask).toHaveBeenCalledWith("t1", "l-1/closed", "", "");
  });

  it("soltarla donde ya estaba no cuesta una petición", async () => {
    montar([tarea("t1", "resolved", "l-1")]);
    await onMove.fn!({ itemId: "t1", toColumnId: "done" });
    // «resolved» normaliza a «done»: es la misma columna, con otro nombre.
    expect(moveTask).not.toHaveBeenCalled();
  });

  // Qué columnas se ofrecen. El tablero las pinta en rojo y rechaza soltar;
  // aquí se comprueba la decisión, que es lo nuestro.
  describe("qué columnas se ofrecen", () => {
    it("de Open a Done no, porque no son adyacentes", () => {
      montar([tarea("t1", "pending", "l-1")]);
      expect(puedeSoltar.fn!(tarea("t1", "pending", "l-1"), "done")).toBe(false);
    });

    it("de Open a In progress sí", () => {
      montar([tarea("t1", "pending", "l-1")]);
      expect(puedeSoltar.fn!(tarea("t1", "pending", "l-1"), "in_progress")).toBe(true);
    });

    // El caso del vocabulario: el servidor dice «resolved» y el tablero «done».
    // Sin normalizar, esto diría que una tarjeta no puede quedarse donde está.
    it("un servidor que dice «resolved» se entiende con una columna «done»", () => {
      montar([tarea("t1", "resolved", "l-1")]);
      expect(puedeSoltar.fn!(tarea("t1", "resolved", "l-1"), "done")).toBe(true);
    });

    it("de Closed no se sale", () => {
      montar([tarea("t1", "closed", "l-1")]);
      expect(puedeSoltar.fn!(tarea("t1", "closed", "l-1"), "in_progress")).toBe(false);
    });
  });
});
