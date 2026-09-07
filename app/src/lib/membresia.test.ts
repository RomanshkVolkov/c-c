import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Que te añadan a una organización con la app abierta.
 *
 * El token que hay en memoria lo firmó el servidor **antes** de que te
 * añadieran, así que sigue diciendo que no perteneces. Pedir las organizaciones
 * con él devuelve la lista de antes y deja la pantalla exactamente igual — que
 * es el fallo que esto viene a arreglar, reproducido por hacer las cosas en el
 * orden cómodo.
 *
 * Por eso lo que se prueba aquí es el **orden**, no que se llame a las tres.
 */

const pasos: string[] = [];

vi.mock("@/lib/api", () => ({
  // Cede antes de apuntarse, como haría una petición de verdad. Con un doble
  // que se apunta antes del primer `await`, lanzarlo sin esperar registraría el
  // token igualmente en primer lugar — y la prueba pasaría con las dos
  // peticiones saliendo con el token viejo, que es exactamente el fallo.
  refreshAccessToken: vi.fn(async () => {
    await Promise.resolve();
    pasos.push("token");
    return "nuevo";
  }),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: {
    getState: () => ({
      fetchOrgs: async () => {
        pasos.push("orgs");
      },
    }),
  },
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: {
    getState: () => ({
      fetchTree: async () => {
        pasos.push("arbol");
      },
    }),
  },
}));

const { adoptarMembresia } = await import("@/lib/membresia");

beforeEach(() => {
  pasos.length = 0;
});

describe("adoptar un cambio de pertenencia", () => {
  it("renueva el token antes de pedir nada", async () => {
    await adoptarMembresia();
    expect(pasos).toEqual(["token", "orgs", "arbol"]);
  });

  // Y **espera** a que llegue. Lanzarlo sin esperar deja las dos peticiones
  // saliendo con el token viejo, que es lo mismo que no renovarlo.
  it("y espera a que el nuevo esté puesto", async () => {
    await adoptarMembresia();
    expect(pasos.indexOf("token")).toBeLessThan(pasos.indexOf("orgs"));
  });
});
