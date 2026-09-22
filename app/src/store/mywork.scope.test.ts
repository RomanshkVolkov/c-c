import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMyWorkStore } from "@/store/mywork.store";
import { useOrgsStore } from "@/store/orgs.store";

/**
 * El filtro de «My work», y de qué organización es.
 *
 * Una lista pertenece a una organización, así que un filtro por lista **no
 * significa nada** en otra. Dejarlo puesto vaciaba la pantalla y parecía que no
 * tenías trabajo, con un rótulo arriba diciendo el nombre de una lista que ya no
 * existe ahí.
 *
 * Lo delicado es el otro lado, y son dos cosas distintas:
 *
 * - `load` se llama también al cambiar de lente y al pedir los estados
 *   cerrados. Tirar el filtro ahí sería quitarle a alguien algo que acaba de
 *   poner, y pasa a cada clic.
 * - Y `load` se llama **al montar la pantalla**, que es justo después de que un
 *   clic en el árbol ponga el filtro. Preguntarle a la carga anterior de qué
 *   organización era —que es como estaba— contesta «de ninguna» la primera vez
 *   de la sesión, así que el filtro recién puesto se caía y **hacían falta dos
 *   clics para filtrar**.
 *
 * Por eso la pregunta se le hace al ámbito, que sabe de dónde es.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
  refreshAccessToken: vi.fn(),
}));

const LISTA = { kind: "list" as const, id: "l-1", name: "web · tasks" };

/** Pone la organización activa, que es de donde `setScope` saca el sello. */
const en = (orgId: string | null) => useOrgsStore.setState({ currentOrgId: orgId });

describe("el ámbito de My work", () => {
  beforeEach(() => {
    useMyWorkStore.setState({ scope: null, orgId: null, tasks: [] });
    en(null);
  });

  /**
   * **El que importa**: el filtro que pone un clic sobrevive a la carga que
   * viene detrás.
   *
   * El clic pone el ámbito y navega; «My work» se monta y lo primero que hace es
   * `load`. Si esa carga lo tira, el clic no ha servido de nada — y el segundo
   * sí, porque la pantalla ya está montada y no vuelve a cargar. Ése era el
   * fallo, y es el estado de arranque: nada cargado todavía.
   *
   * El mutante que mata: volver a comparar con la organización de la carga
   * anterior.
   */
  it("un filtro puesto antes de la primera carga sobrevive", async () => {
    en("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().scope).toMatchObject(LISTA);
  });

  it("se tira al cargar otra organización", async () => {
    en("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-b");
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  // Recargar la misma —al cambiar de lente, o al pedir lo cerrado— **no** puede
  // tocarlo.
  it("y sobrevive a recargar la misma", async () => {
    en("org-a");
    await useMyWorkStore.getState().load("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().scope).toMatchObject(LISTA);
  });

  // Sin organización elegida es un estado real —un superadmin recién entrado— y
  // volver de él a una concreta también es un cambio.
  it("de «ninguna» a una concreta también cuenta", async () => {
    en(null);
    useMyWorkStore.getState().setScope(LISTA);
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  /**
   * El sello lo pone el store, no quien llama.
   *
   * Es lo que hace que la comprobación de arriba valga para las cuatro formas
   * que hay de cambiar de organización sin acordarse de ninguna; un ámbito sin
   * sellar no se tiraría nunca.
   */
  it("setScope anota la organización activa", () => {
    en("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    expect(useMyWorkStore.getState().scope?.orgId).toBe("org-a");
  });

  // Quitarse el filtro sigue siendo quitárselo, no sellar un null.
  it("y quitarlo lo deja sin nada", () => {
    en("org-a");
    useMyWorkStore.getState().setScope(LISTA);
    useMyWorkStore.getState().setScope(null);
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  // Lo que sí sigue anotando `load`: de dónde son las tareas que hay, para que
  // un evento pueda pedir la misma lista otra vez.
  it("la carga deja anotada su organización", async () => {
    await useMyWorkStore.getState().load("org-a");
    expect(useMyWorkStore.getState().orgId).toBe("org-a");
  });
});
