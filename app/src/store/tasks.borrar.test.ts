import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Borrar una tarea la quita **de todas partes**.
 *
 * El fallo que esto cierra: «My work» sirve sus filas por su cuenta —junta
 * tareas de todas las listas— así que refrescar el tablero no la tocaba.
 * Borrando desde ahí, la tarjeta se quedaba en pantalla y seguía pulsable, y lo
 * único que decía que ya no existía era un «not found» al abrirla.
 *
 * Importa más de lo que parece: deja dudando de si el borrado funcionó, quien
 * lo ve vuelve a borrar, y en una lista de tareas parecidas el segundo intento
 * se lleva la equivocada.
 */

const { del, get, patch, post } = vi.hoisted(() => ({
  del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { delete: del, get, patch, post, put: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "org-1" }) },
}));

const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");

const tarea = (id: string) => ({ id, title: id }) as never;

beforeEach(() => {
  [del, get, patch, post].forEach((f) => f.mockClear());
  del.mockResolvedValue({ success: true });
  get.mockResolvedValue({ success: true, data: [] });
  useMyWorkStore.setState({ tasks: [tarea("t-1"), tarea("t-2")] });
  useTasksStore.setState({ activeListId: null, openTaskId: null, detail: null });
});

describe("borrar una tarea", () => {
  it("la quita de «My work», que se servía aparte", async () => {
    await useTasksStore.getState().deleteTask("t-1");
    expect(useMyWorkStore.getState().tasks.map((t) => t.id)).toEqual(["t-2"]);
  });

  it("y no se lleva por delante a las demás", async () => {
    await useTasksStore.getState().deleteTask("t-1");
    expect(useMyWorkStore.getState().tasks).toHaveLength(1);
  });

  // Borrar una que no está ahí es normal —se borró desde el tablero— y no
  // puede vaciar la lista ni reventar.
  it("borrar una que no estaba en la lista no la toca", async () => {
    await useTasksStore.getState().deleteTask("t-9");
    expect(useMyWorkStore.getState().tasks).toHaveLength(2);
  });

  it("cierra el detalle si era el que estaba abierto", async () => {
    useTasksStore.setState({ openTaskId: "t-1", detail: tarea("t-1") });
    await useTasksStore.getState().deleteTask("t-1");
    expect(useTasksStore.getState().openTaskId).toBeNull();
    expect(useTasksStore.getState().detail).toBeNull();
  });

  // Y no cierra el de otra: borrar en segundo plano no puede tirarte de la
  // tarjeta que estás leyendo.
  it("y no cierra el de otra tarea", async () => {
    useTasksStore.setState({ openTaskId: "t-2", detail: tarea("t-2") });
    await useTasksStore.getState().deleteTask("t-1");
    expect(useTasksStore.getState().openTaskId).toBe("t-2");
  });
});

describe("olvidar, por su cuenta", () => {
  it("quita sólo la que se le dice", () => {
    useMyWorkStore.getState().olvidar("t-2");
    expect(useMyWorkStore.getState().tasks.map((t) => t.id)).toEqual(["t-1"]);
  });
});
