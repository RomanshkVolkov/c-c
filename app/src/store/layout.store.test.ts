import { beforeEach, describe, expect, it } from "vitest";

import { expansionKey, useLayoutStore } from "@/store/layout.store";

/**
 * Lo que el sidebar recuerda de quien mira.
 *
 * Lo plegado a mano va **por org y por módulo**: plegar «Proteus» en un
 * cliente no puede plegar el espacio del mismo id en otra org (no existe,
 * pero el de al lado sí, y un mapa sin org es un mapa compartido). Mutantes:
 * quitar `orgId` de la clave; `reveal` que no olvida.
 */
beforeEach(() => {
  useLayoutStore.setState({ expanded: {}, lastRoute: {}, activeModule: "work", panelOpen: true });
});

describe("lo desplegado de un árbol", () => {
  it("se guarda bajo su org y su módulo", () => {
    useLayoutStore.getState().setExpanded("org-a", "work", "sp-1", false);
    const s = useLayoutStore.getState().expanded;
    expect(s[expansionKey("org-a", "work")]).toEqual({ "sp-1": false });
    expect(s[expansionKey("org-b", "work")]).toBeUndefined();
    expect(s[expansionKey("org-a", "docs")]).toBeUndefined();
  });

  it("guarda el cerrado igual que el abierto: los dos son decisiones", () => {
    const { setExpanded } = useLayoutStore.getState();
    setExpanded("org-a", "work", "fo-1", true);
    setExpanded("org-a", "work", "sp-1", false);
    expect(useLayoutStore.getState().expanded[expansionKey("org-a", "work")]).toEqual({ "fo-1": true, "sp-1": false });
  });

  it("revelar olvida lo decidido sobre esos ids, y sólo sobre ésos", () => {
    const { setExpanded, reveal } = useLayoutStore.getState();
    setExpanded("org-a", "work", "sp-1", false);
    setExpanded("org-a", "work", "sp-2", false);
    reveal("org-a", "work", ["sp-1", "li-9"]);
    expect(useLayoutStore.getState().expanded[expansionKey("org-a", "work")]).toEqual({ "sp-2": false });
  });
});

describe("la última ruta de cada módulo", () => {
  it("se apunta por módulo, con su búsqueda", () => {
    const { rememberRoute } = useLayoutStore.getState();
    rememberRoute("comms", "/chat?space=sp-2");
    rememberRoute("work", "/tasks");
    expect(useLayoutStore.getState().lastRoute).toEqual({ comms: "/chat?space=sp-2", work: "/tasks" });
  });
});

/**
 * La v1 guardaba `collapsed`, el plegado de las columnas de canales y
 * directos que ya no existen. Al leerla se tira eso y se conserva lo demás.
 * Mutante: un `migrate` que no toca nada.
 */
describe("lo guardado por la versión anterior", () => {
  it("pierde las columnas plegadas y conserva lo demás", async () => {
    localStorage.setItem(
      "cac-layout",
      JSON.stringify({ state: { collapsed: { channels: true }, comms: "/dm" }, version: 1 }),
    );
    await useLayoutStore.persist.rehydrate();
    const s = useLayoutStore.getState() as unknown as Record<string, unknown>;
    expect(s.collapsed).toBeUndefined();
    expect(s.comms).toBe("/dm");
    expect(s.panelOpen).toBe(true);
    const saved = JSON.parse(localStorage.getItem("cac-layout") ?? "{}");
    expect(saved.version).toBe(2);
    expect(saved.state.collapsed).toBeUndefined();
  });
});
