import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMyWorkStore } from "@/store/mywork.store";

/**
 * El filtro de «My work» al cambiar de organización.
 *
 * Una lista pertenece a una organización, así que un filtro por lista **no
 * significa nada** en otra. Dejarlo puesto vaciaba la pantalla y parecía que no
 * tenías trabajo, con un rótulo arriba diciendo el nombre de una lista que ya no
 * existe ahí.
 *
 * Lo que hace esto delicado es el otro lado: `load` se llama también al cambiar
 * de lente y al pedir los estados cerrados. Tirar el filtro en esos casos sería
 * quitarle a alguien algo que acaba de poner, y ese fallo es más molesto que el
 * original porque pasa a cada clic.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
}));

const LISTA = { kind: "list" as const, id: "l-1", name: "web · tasks" };

describe("el ámbito de My work", () => {
  beforeEach(() => {
    useMyWorkStore.setState({ scope: null, loadedOrgId: null, tasks: [] });
  });

  it("se tira al cambiar de organización", async () => {
    const s = useMyWorkStore.getState();
    await s.load("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-b");
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  // El que importa de verdad: recargar la misma organización —al cambiar de
  // lente, o al pedir lo cerrado— **no** puede tocarlo.
  it("y sobrevive a recargar la misma", async () => {
    await useMyWorkStore.getState().load("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().scope).toEqual(LISTA);
  });

  // Sin esto, la primera carga de la sesión borraría un ámbito que nadie puso
  // —no hay ninguno— pero dejaría `loadedOrgId` sin escribir, y la segunda
  // carga de la misma organización parecería un cambio.
  it("la primera carga deja anotada la organización", async () => {
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().loadedOrgId).toBe("org-a");
  });

  // Sin organización elegida es un estado real —un superadmin recién entrado—
  // y volver de él a una concreta también es un cambio.
  it("de «ninguna» a una concreta también cuenta", async () => {
    await useMyWorkStore.getState().load(null);
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().scope).toBeNull();
  });
});
