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
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b: unknown) => post(p, b),
    put: vi.fn(),
    delete: (p: string) => del(p),
  },
  apiUrl: (p: string) => p,
}));

const { useDocPages, placeLocally } = await import("@/store/doc-pages.store");

const A = { kind: "list" as const, id: "A" };
const B = { kind: "list" as const, id: "B" };
const row = (id: string, parentId?: string) => ({ id, parentId, rank: "0.5", title: id, hasBody: false, updatedAt: "" });

beforeEach(() => {
  get.mockReset();
  del.mockReset();
  post.mockReset();
  useDocPages.getState().reset();
});

describe("las páginas de un documento", () => {
  it("un enlace a una página sobrevive a que se pinte el documento", async () => {
    get.mockImplementation(async (p: string) =>
      p.endsWith("/pages") ? { data: [row("p1")] } : { data: { page: { id: "p1" }, breadcrumb: [], children: [] } },
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
    let releaseA!: (v: unknown) => void;
    get.mockImplementation((p: string) =>
      p.includes("/list/A/")
        ? new Promise((r) => (releaseA = r))
        : Promise.resolve({ data: [row("de-B")] }),
    );
    const a = useDocPages.getState().enter(A);
    await useDocPages.getState().enter(B);
    releaseA({ data: [row("de-A")] });
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
    get.mockResolvedValue({ data: [row("p1"), row("p2", "p1"), row("p3", "p2"), row("otra")] });
    await useDocPages.getState().enter(A);
    del.mockResolvedValue({ data: { pages: 3 } });
    await useDocPages.getState().trashPage(A, "p1");
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["otra"]);
  });

  it("si la abierta cuelga de la que se tira, se vuelve a la portada", async () => {
    get.mockImplementation(async (p: string) =>
      p.endsWith("/pages")
        ? { data: [row("p1"), row("p2", "p1")] }
        : { data: { page: { id: "p2" }, breadcrumb: [], children: [] } },
    );
    await useDocPages.getState().enter(A);
    await useDocPages.getState().openPage(A, "p2");
    del.mockResolvedValue({ data: { pages: 2 } });
    await useDocPages.getState().trashPage(A, "p1");
    expect(useDocPages.getState().activePageId).toBeNull();
  });
});

const ids = () => useDocPages.getState().tree.map((x) => `${x.id}<${x.parentId ?? "·"}`);

describe("mover una página", () => {
  const tree = () => [row("a"), row("a1", "a"), row("a2", "a"), row("b")];

  it("se pinta ya en su sitio, antes de que conteste el servidor", () => {
    expect(placeLocally(tree(), "b", { parentId: "a", beforeId: "a1" }).map((x) => x.id)).toEqual([
      "a", "b", "a1", "a2",
    ]);
    expect(placeLocally(tree(), "b", { parentId: "a", afterId: "a1" }).map((x) => x.id)).toEqual([
      "a", "a1", "b", "a2",
    ]);
    // Sin vecina, al final de las hijas de la madre nueva.
    expect(placeLocally(tree(), "b", { parentId: "a" }).map((x) => x.id)).toEqual(["a", "a1", "a2", "b"]);
    expect(placeLocally(tree(), "b", { parentId: "a" }).find((x) => x.id === "b")!.parentId).toBe("a");
  });

  it("si el servidor lo rechaza, vuelve a donde estaba", async () => {
    useDocPages.setState({ owner: A, tree: tree() });
    let reject!: (e: unknown) => void;
    post.mockReturnValue(new Promise((_, r) => (reject = r)));
    const m = useDocPages.getState().movePage(A, "b", { parentId: "a", afterId: "a2" });
    expect(ids()).toEqual(["a<·", "a1<a", "a2<a", "b<a"]);
    reject(new Error("page-cycle"));
    await expect(m).rejects.toThrow();
    expect(ids()).toEqual(["a<·", "a1<a", "a2<a", "b<·"]);
  });

  it("y si lo acepta, se queda con el árbol que contesta", async () => {
    useDocPages.setState({ owner: A, tree: tree() });
    post.mockResolvedValue({ data: [row("b"), row("a")] });
    await useDocPages.getState().movePage(A, "b", { parentId: null, beforeId: "a" });
    expect(ids()).toEqual(["b<·", "a<·"]);
  });

  it("soltar dentro la pone al final de las hijas", async () => {
    useDocPages.setState({ owner: A, tree: tree() });
    post.mockResolvedValue({ data: tree() });
    await useDocPages.getState().dropPage(A, "b", "a", "inside");
    expect(post).toHaveBeenCalledWith("/api/v1/docs/list/A/pages/b/move", { parentId: "a", afterId: "a2" });
  });

  it("soltar encima o debajo la pone junto a la otra, con su misma madre", async () => {
    useDocPages.setState({ owner: A, tree: tree() });
    post.mockResolvedValue({ data: tree() });
    await useDocPages.getState().dropPage(A, "b", "a1", "before");
    expect(post).toHaveBeenLastCalledWith("/api/v1/docs/list/A/pages/b/move", { parentId: "a", beforeId: "a1" });
    await useDocPages.getState().dropPage(A, "b", "a1", "after");
    expect(post).toHaveBeenLastCalledWith("/api/v1/docs/list/A/pages/b/move", { parentId: "a", afterId: "a1" });
  });

  it("dentro de sí misma o de su subárbol no se manda", async () => {
    useDocPages.setState({ owner: A, tree: tree() });
    await useDocPages.getState().dropPage(A, "a", "a1", "inside");
    await useDocPages.getState().dropPage(A, "a", "a", "after");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("la papelera y el historial", () => {
  it("restaurar la quita de la papelera y vuelve a pedir el árbol", async () => {
    useDocPages.setState({ owner: A, trash: [row("t1"), row("t2")] });
    post.mockResolvedValue({ success: true });
    get.mockResolvedValue({ data: [row("t1")] });
    await useDocPages.getState().restorePage(A, "t1");
    expect(post).toHaveBeenCalledWith("/api/v1/docs/list/A/pages/t1/restore", {});
    expect(useDocPages.getState().trash.map((x) => x.id)).toEqual(["t2"]);
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["t1"]);
  });

  it("restaurar una versión pone su texto en la página abierta", async () => {
    useDocPages.setState({
      owner: A,
      activePageId: "p1",
      tree: [row("p1")],
      view: { page: { id: "p1", title: "x", body: "ahora" } as never, breadcrumb: [], children: [], orgId: "o" },
    });
    post.mockResolvedValue({ data: { id: "p1", title: "Antes", body: "antes", bodyHash: "h2" } });
    await useDocPages.getState().restorePageVersion(A, "p1", "v9");
    expect(post).toHaveBeenCalledWith("/api/v1/docs/list/A/pages/p1/versions/v9/restore", {});
    expect(useDocPages.getState().view?.page.body).toBe("antes");
    expect(useDocPages.getState().tree[0].title).toBe("Antes");
  });
});

describe("la pestaña que pide un enlace", () => {
  it("vuelve a la portada y la deja pedida hasta que se recoja", () => {
    useDocPages.setState({ activePageId: "p1" });
    useDocPages.getState().requestTab("runbook");
    expect(useDocPages.getState().activePageId).toBeNull();
    expect(useDocPages.getState().takeRequestedTab()).toBe("runbook");
    expect(useDocPages.getState().takeRequestedTab()).toBeNull();
  });

  it("una pestaña que no existe no se pide, ni cierra la página", () => {
    useDocPages.setState({ activePageId: "p1" });
    useDocPages.getState().requestTab("nada");
    useDocPages.getState().requestTab(undefined);
    expect(useDocPages.getState().activePageId).toBe("p1");
    expect(useDocPages.getState().requestedTab).toBeNull();
  });
});

/**
 * Las páginas de los documentos que no son el abierto, para pintarlas en el
 * panel. Se guardan aparte de `tree` porque `tree` es del documento abierto y
 * todas las mutaciones escriben ahí. Mutantes: guardar el árbol saliente
 * después de `reset()` (se guardaría vacío); `peekPages` escribiendo `tree`;
 * abrir una página de otro documento sin vaciar el árbol del anterior.
 */
describe("las páginas de otros documentos", () => {
  it("al entrar en otro documento, el que se deja queda en la caché", async () => {
    get.mockImplementation(async (p: string) => ({ data: p.includes("/A/") ? [row("a1")] : [row("b1")] }));
    await useDocPages.getState().enter(A);
    await useDocPages.getState().enter(B);
    expect(useDocPages.getState().pagesByOwner["list:A"]?.map((x) => x.id)).toEqual(["a1"]);
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["b1"]);
  });

  it("asomarse a otro documento no toca el abierto", async () => {
    get.mockImplementation(async (p: string) => ({ data: p.includes("/A/") ? [row("a1")] : [row("b1"), row("b2")] }));
    await useDocPages.getState().enter(A);
    await useDocPages.getState().peekPages(B);
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["a1"]);
    expect(useDocPages.getState().owner).toEqual(A);
    expect(useDocPages.getState().pagesByOwner["list:B"]?.map((x) => x.id)).toEqual(["b1", "b2"]);
  });

  it("abrir una página de otro documento vacía el árbol del anterior", async () => {
    get.mockImplementation(async (p: string) => ({ data: p.includes("/pages/") ? null : [row("a1")] }));
    await useDocPages.getState().enter(A);
    void useDocPages.getState().openPage(B, "b9");
    expect(useDocPages.getState().owner).toEqual(B);
    expect(useDocPages.getState().tree).toEqual([]);
    expect(useDocPages.getState().pagesByOwner["list:A"]?.map((x) => x.id)).toEqual(["a1"]);
  });

  it("una página del mismo documento no vacía nada", async () => {
    get.mockImplementation(async (p: string) => ({ data: p.includes("/pages/") ? null : [row("a1")] }));
    await useDocPages.getState().enter(A);
    void useDocPages.getState().openPage(A, "a1");
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["a1"]);
  });
});
