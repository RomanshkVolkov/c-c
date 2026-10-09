import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lo que ofrece `[[`: primero las páginas del documento abierto, sin acentos ni
 * mayúsculas y sin la propia página; a partir de dos letras, también las de
 * toda la organización por la búsqueda, sin repetir; y si la búsqueda falla,
 * lo de aquí igualmente.
 */

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (p: string) => get(p) }, apiUrl: (p: string) => p }));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: { getState: () => ({ activeDoc: { kind: "list", id: "l1", name: "Apps" } }) },
}));
vi.mock("@/store/orgs.store", () => ({ useOrgsStore: { getState: () => ({ currentOrgId: "o1" }) } }));

const { docLinks } = await import("@/components/docs/doc-links");
const { useDocPages } = await import("@/store/doc-pages.store");

const fila = (id: string, title: string, parentId?: string) => ({
  id, title, parentId, rank: "0.5", hasBody: true, updatedAt: "",
});

beforeEach(() => {
  get.mockReset();
  useDocPages.setState({
    owner: { kind: "list", id: "l1" },
    activePageId: "yo",
    tree: [fila("p1", "Configuración"), fila("p2", "Despliegue", "p1"), fila("yo", "Configurar el VPN")],
  });
});

describe("lo que ofrece [[", () => {
  it("las de aquí, sin acentos y sin la propia página, con su ruta", async () => {
    const r = await docLinks("c");
    expect(r).toEqual([{ href: "/tasks?doc=list:l1&page=p1", title: "Configuración", where: "Apps" }]);
    expect(get).not.toHaveBeenCalled();
    const d = await docLinks("desp");
    expect(d[0].where).toBe("Apps › Configuración");
  });

  it("a partir de dos letras, también las de fuera, sin repetir", async () => {
    get.mockResolvedValue({
      data: {
        docs: [
          { title: "Configuración", link: "/tasks?doc=list:l1&page=p1" },
          { title: "Configuración", where: "Proteus › Plataforma", link: "/tasks?doc=list:l9&page=x" },
          { title: "Proteus", tab: "runbook", link: "/tasks?doc=space:s1&tab=runbook" },
        ],
      },
    });
    const r = await docLinks("configuracion");
    expect(get).toHaveBeenCalledWith("/api/v1/search/?orgId=o1&q=configuracion");
    expect(r.map((x) => x.href)).toEqual([
      "/tasks?doc=list:l1&page=p1",
      "/tasks?doc=list:l9&page=x",
      "/tasks?doc=space:s1&tab=runbook",
    ]);
    expect(r[2].title).toBe("Proteus · Runbook");
  });

  it("si la búsqueda falla, lo de aquí", async () => {
    get.mockRejectedValue(new Error("caído"));
    const r = await docLinks("configuracion");
    expect(r.map((x) => x.title)).toEqual(["Configuración"]);
  });
});
