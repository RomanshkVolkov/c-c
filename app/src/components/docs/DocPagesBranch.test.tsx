import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * Las páginas de un documento en el panel de Documentación: la portada
 * arriba, las páginas anidadas debajo, y el «+» de cada fila crea **dentro**
 * de esa fila — lo que hace Confluence. Antes era el árbol lateral de
 * `DocTabs` (`DocPageTree`); estas pruebas vienen de ahí.
 *
 * Lo nuevo: las páginas nacen plegadas (un árbol todo abierto es una lista de
 * doscientas filas) y lo desplegado se recuerda por org; y la rama de un
 * documento que **no** es el abierto sólo se lee. Mutantes: nacer abiertas;
 * `peekPages` al repintar; enseñar «+» o el menú en una rama de sólo lectura.
 */

const post = vi.fn();
const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (p: string) => get(p), post: (p: string, b: unknown) => post(p, b), put: (p: string, b: unknown) => put(p, b), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));

const { default: DocPagesBranchBare } = await import("@/components/docs/DocPagesBranch");
const { useDocPages } = await import("@/store/doc-pages.store");
const { useLayoutStore } = await import("@/store/layout.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

// Dentro de los proveedores, como en la app (`App.tsx`). La del documento
// abierto salvo que se diga otra cosa.
const Branch = (p: { kind: "space"; ownerId: string; active?: boolean; onOpenOther?: (p: unknown) => void }) => (
  <ConfirmProvider>
    <PromptProvider>
      <DocPagesBranchBare depth={0} active={p.active ?? true} {...p} />
    </PromptProvider>
  </ConfirmProvider>
);

/** Despliega una página por su chevrón. */
const expand = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Expand ${title}` }));

const row = (id: string, title: string, parentId?: string) => ({
  id,
  title,
  parentId,
  rank: "0.5",
  hasBody: false,
  updatedAt: "",
});

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  put.mockReset();
  get.mockResolvedValue({ data: [] });
  useDocPages.setState({
    owner: { kind: "space", id: "s1" },
    activePageId: null,
    view: null,
    pagesByOwner: {},
    tree: [row("p1", "Apps"), row("p2", "Nereus", "p1"), row("p3", "Triton", "p1"), row("p4", "Entrega")],
  });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useLayoutStore.setState({ expanded: {} });
});
afterEach(cleanup);

describe("el árbol de páginas", () => {
  it("anida cada página bajo su madre, en su orden", () => {
    render(<Branch kind="space" ownerId="s1" />);
    expand("Apps");
    const appsRow = screen.getByText("Apps").closest("li")!;
    expect([...appsRow.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["Nereus", "Triton"]);
    expect(screen.getByText("Entrega").closest("li")!.parentElement!.closest("li")).toBeNull();
  });

  it("las páginas nacen plegadas, y desplegar se recuerda por org", () => {
    render(<Branch kind="space" ownerId="s1" />);
    expect(screen.queryByText("Nereus")).toBeNull();
    expect(screen.getByText("Entrega")).toBeTruthy();
    expand("Apps");
    expect(screen.getByText("Nereus")).toBeTruthy();
    expect(useLayoutStore.getState().expanded["org-1/docs"]).toEqual({ "page:p1": true });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Apps" }));
    expect(screen.queryByText("Nereus")).toBeNull();
  });

  it("el «+» de una fila crea una hija suya", async () => {
    post.mockResolvedValue({ data: null });
    render(<Branch kind="space" ownerId="s1" />);
    const appsRow = screen.getByText("Apps").closest("li")!.firstElementChild!;
    fireEvent.click(appsRow.querySelector('button[aria-label="New page inside"]')!);
    expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages", { title: "Untitled", parentId: "p1" });
  });

  it("el «+» de la portada crea una página de primer nivel", () => {
    post.mockResolvedValue({ data: null });
    render(<Branch kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages", { title: "Untitled" });
  });

  it("la portada cierra la página abierta", () => {
    useDocPages.setState({ activePageId: "p2" });
    render(<Branch kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByText("Home"));
    expect(useDocPages.getState().activePageId).toBeNull();
  });
});

/** Abre el menú de una fila y pulsa una opción. */
const pickFromMenu = async (title: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Options for “${title}”` }));
  fireEvent.click(await screen.findByText(option));
};

describe("el menú de una página", () => {
  it("renombrar pregunta el título y lo guarda", async () => {
    put.mockResolvedValue({ data: { id: "p2", title: "Nereus 2" } });
    render(<Branch kind="space" ownerId="s1" />);
    expand("Apps");
    await pickFromMenu("Nereus", "Rename");
    const box = await screen.findByDisplayValue("Nereus");
    fireEvent.change(box, { target: { value: "Nereus 2" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages/p2", { title: "Nereus 2" }));
  });

  /**
   * «Mover a…»: lo que no puede ser no se ofrece. La propia página y lo que
   * cuelga de ella salen atenuadas; la portada y las demás, sí.
   */
  it("mover a… no deja colgarla de sí misma ni de sus hijas", async () => {
    render(<Branch kind="space" ownerId="s1" />);
    await pickFromMenu("Apps", "Move to…");
    const dialog = await screen.findByRole("dialog");
    const option = (t: string) => within(dialog).getByText(t).closest("button")!;
    expect(option("Apps").disabled).toBe(true);
    expect(within(dialog).queryByText("Nereus")).toBeNull();
    expect(option("Entrega").disabled).toBe(false);
  });

  it("mover a… la pone al final de la madre elegida", async () => {
    post.mockResolvedValue({ data: [] });
    render(<Branch kind="space" ownerId="s1" />);
    await pickFromMenu("Entrega", "Move to…");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Apps"));
    fireEvent.click(within(dialog).getByText("Move here"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages/p4/move", { parentId: "p1", afterId: "p3" }),
    );
  });

  it("donde ya está no se puede mover", async () => {
    render(<Branch kind="space" ownerId="s1" />);
    expand("Apps");
    await pickFromMenu("Nereus", "Move to…");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Apps"));
    expect(within(dialog).getByText("Move here").closest("button")!.disabled).toBe(true);
  });

  it("a la papelera pregunta, y dice cuántas se van con ella", async () => {
    render(<Branch kind="space" ownerId="s1" />);
    await pickFromMenu("Apps", "Move to trash");
    expect(await screen.findByText(/The 2 pages inside it go with it/)).toBeTruthy();
  });
});

describe("la papelera", () => {
  it("dice cuándo y cuántas, y restaurar trae la página", async () => {
    let restored = false;
    get.mockImplementation(async (p: string) =>
      p.endsWith("?trashed=1")
        ? { data: restored ? [] : [{ ...row("t1", "Viejo"), deletedAt: "2026-10-08T12:00:00Z", subpages: 3 }] }
        : // Tras restaurar, el árbol la trae de vuelta.
          { data: restored ? [row("t1", "Viejo")] : [] },
    );
    post.mockImplementation(async () => {
      restored = true;
      return { success: true };
    });
    render(<Branch kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    expect(await screen.findByText("Viejo")).toBeTruthy();
    expect(screen.getByText(/3 pages inside/)).toBeTruthy();
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages/t1/restore", {}));
    // Fuera de la papelera, y de vuelta en el árbol.
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByText("Viejo")).toBeNull());
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["t1"]);
  });
});

/**
 * La rama de un documento que no es el abierto: se ve y se abre, nada más.
 */
describe("la rama de otro documento", () => {
  beforeEach(() => {
    get.mockResolvedValue({ data: [row("o1", "Ajena"), row("o2", "Hija", "o1")] });
  });

  it("pide sus páginas una vez, sin tocar las del abierto", async () => {
    const { rerender } = render(<Branch kind="space" ownerId="s9" active={false} />);
    expect(await screen.findByText("Ajena")).toBeTruthy();
    rerender(<Branch kind="space" ownerId="s9" active={false} />);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/v1/docs/space/s9/pages");
    expect(useDocPages.getState().tree.map((x) => x.id)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("sin portada, sin «+» y sin menú", async () => {
    render(<Branch kind="space" ownerId="s9" active={false} />);
    await screen.findByText("Ajena");
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.queryByRole("button", { name: "New page inside" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Options for “Ajena”" })).toBeNull();
  });

  it("pulsar una página se la pasa a quien sabe abrirla", async () => {
    const onOpenOther = vi.fn();
    render(<Branch kind="space" ownerId="s9" active={false} onOpenOther={onOpenOther} />);
    fireEvent.click(await screen.findByText("Ajena"));
    expect(onOpenOther).toHaveBeenCalledWith(expect.objectContaining({ id: "o1" }));
    expect(useDocPages.getState().activePageId).toBeNull();
  });

  it("lo ya cacheado no se vuelve a pedir", () => {
    useDocPages.setState({ pagesByOwner: { "space:s9": [row("o1", "Ajena")] } });
    render(<Branch kind="space" ownerId="s9" active={false} />);
    expect(screen.getByText("Ajena")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});
