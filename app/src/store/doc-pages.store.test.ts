import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El árbol de páginas del documento abierto.
 *
 * Tres cosas que se rompen sin hacer ruido: un enlace con `&page=` que se
 * cierra solo al pintarse el documento, el árbol de un nodo que se dejó atrás
 * pintado encima del de ahora, y una página en la papelera cuyas hijas siguen
 * en el lateral.
 */

const get = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(),
    put: vi.fn(),
    delete: (p: string) => del(p),
  },
  apiUrl: (p: string) => p,
}));

const { useDocPages } = await import("@/store/doc-pages.store");

const A = { kind: "list" as const, id: "A" };
const B = { kind: "list" as const, id: "B" };
const fila = (id: string, parentId?: string) => ({ id, parentId, rank: "0.5", title: id, hasBody: false, updatedAt: "" });

beforeEach(() => {
  get.mockReset();
  del.mockReset();
  useDocPages.getState().reset();
});

describe("las páginas de un documento", () => {
  it("un enlace a una página sobrevive a que se pinte el documento", async () => {
    get.mockImplementation(async (p: string) =>
      p.endsWith("/pages") ? { data: [fila("p1")] } : { data: { page: { id: "p1" }, breadcrumb: [], children: [] } },
    );
    // Lo que hace el enlace: abrir la página primero…
    await useDocPages.getState().openPage(A, "p1");
    // …y después el documento, que al pintarse entra en su nodo.
    await useDocPages.getState().enter(A);
    expect(useDocPages.getState().activePageId).toBe("p1");
  });

  it("otro nodo cierra la página que hubiera abierta", async () => {
    get.mockImplementation(async (p: string) =>
      p.endsWith("/pages") ? { data: [] } : { data: { page: { id: "p1" }, breadcrumb: [], children: [] } },
    );
    await useDocPages.getState().openPage(A, "p1");
    await useDocPages.getState().enter(B);
    expect(useDocPages.getState().activePageId).toBeNull();
    expect(useDocPages.getState().view).toBeNull();
  });

  it("el árbol de un nodo que se dejó atrás no se pinta encima", async () => {
    let soltarA!: (v: unknown) => void;
    get.mockImplementation((p: string) =>
      p.includes("/list/A/")
        ? new Promise((r) => (soltarA = r))
        : Promise.resolve({ data: [fila("de-B")] }),
    );
    const a = useDocPages.getState().enter(A);
    await useDocPages.getState().enter(B);
    soltarA({ data: [fila("de-A")] });
    await a;
    expect(useDocPages.getState().owner).toEqual(B);
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["de-B"]);
  });

  it("un servidor sin páginas deja el árbol vacío, no roto", async () => {
    get.mockResolvedValue({ data: { algo: "que no es un árbol" } });
    await useDocPages.getState().enter(A);
    expect(useDocPages.getState().tree).toEqual([]);
  });

  it("a la papelera se va con todo lo que cuelga de ella", async () => {
    get.mockResolvedValue({ data: [fila("p1"), fila("p2", "p1"), fila("p3", "p2"), fila("otra")] });
    await useDocPages.getState().enter(A);
    del.mockResolvedValue({ data: { pages: 3 } });
    await useDocPages.getState().trashPage(A, "p1");
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["otra"]);
  });

  it("si la abierta cuelga de la que se tira, se vuelve a la portada", async () => {
    get.mockImplementation(async (p: string) =>
      p.endsWith("/pages")
        ? { data: [fila("p1"), fila("p2", "p1")] }
        : { data: { page: { id: "p2" }, breadcrumb: [], children: [] } },
    );
    await useDocPages.getState().enter(A);
    await useDocPages.getState().openPage(A, "p2");
    del.mockResolvedValue({ data: { pages: 2 } });
    await useDocPages.getState().trashPage(A, "p1");
    expect(useDocPages.getState().activePageId).toBeNull();
  });
});
