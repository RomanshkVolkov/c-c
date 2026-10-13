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
