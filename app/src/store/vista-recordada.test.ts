import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cómo prefiere mirar cada quien, recordado entre arranques.
 *
 * Quien prefiere el kanban lo prefiere siempre. Sin esto, cada vez que se abría
 * la app había que volver a elegirlo — un clic diario que no aporta nada, y que
 * además se pierde justo cuando más molesta: al reiniciar tras actualizar.
 *
 * Local y no del equipo: dos personas pueden mirar la misma lista de formas
 * distintas. Y **una por pantalla**, que es la parte que no es obvia.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ session: { id: "yo" } }), subscribe: vi.fn() },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "o1" }), subscribe: vi.fn() },
}));

const { useMyWorkStore } = await import("@/store/mywork.store");
const { useTasksStore } = await import("@/store/tasks.store");

/** Lo que quedaría en disco para el próximo arranque. */
const guardado = (clave: string) =>
  JSON.parse(localStorage.getItem(clave) ?? '{"state":{}}').state as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
});

describe("la vista preferida", () => {
  it("la del tablero sobrevive al arranque", () => {
    useTasksStore.getState().setBoardView("calendar");
    expect(guardado("cac-tasks").boardView).toBe("calendar");
  });

  it("y la de «Mi trabajo» también", () => {
    useMyWorkStore.getState().setVista("board");
    expect(guardado("cac-mywork").vista).toBe("board");
  });

  /**
   * Son dos preferencias, no una.
   *
   * Contestan preguntas distintas —«cómo va este proyecto» y «qué me toca a
   * mí»— y ya tenían distinto valor por defecto: tablero una, lista la otra.
   * Compartir una sola haría que elegir calendario en un sitio cambiara el otro,
   * que es una sorpresa que nadie pidió.
   */
  it("elegir en una pantalla no cambia la otra", () => {
    useTasksStore.getState().setBoardView("board");
    useMyWorkStore.getState().setVista("calendar");
    expect(useTasksStore.getState().boardView).toBe("board");
    expect(useMyWorkStore.getState().vista).toBe("calendar");
  });

  // El tablero de una lista se abre en kanban y «qué me toca» en lista. Son las
  // dos respuestas que ya daba la app antes de que esto se recordara.
  it("de salida, cada una con lo suyo", async () => {
    localStorage.clear();
    const tareas = await import("@/store/tasks.store");
    const mio = await import("@/store/mywork.store");
    expect(tareas.useTasksStore.getInitialState().boardView).toBe("board");
    expect(mio.useMyWorkStore.getInitialState().vista).toBe("list");
  });
});
