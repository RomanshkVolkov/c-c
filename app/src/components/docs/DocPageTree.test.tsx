import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * El árbol del lateral: la portada arriba, las páginas anidadas debajo, y el
 * «+» de cada fila crea **dentro** de esa fila — lo que hace Confluence.
 */

const post = vi.fn();
const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (p: string) => get(p), post: (p: string, b: unknown) => post(p, b), put: (p: string, b: unknown) => put(p, b), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));

const { default: DocPageTreeBare } = await import("@/components/docs/DocPageTree");
const { useDocPages } = await import("@/store/doc-pages.store");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

// Dentro de los proveedores, como en la app (`App.tsx`).
const DocPageTree = (p: { kind: "space"; ownerId: string }) => (
  <ConfirmProvider>
    <PromptProvider>
      <DocPageTreeBare {...p} />
    </PromptProvider>
  </ConfirmProvider>
);

const fila = (id: string, title: string, parentId?: string) => ({
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
    tree: [fila("p1", "Apps"), fila("p2", "Nereus", "p1"), fila("p3", "Triton", "p1"), fila("p4", "Entrega")],
  });
});
afterEach(cleanup);

describe("el árbol de páginas", () => {
  it("anida cada página bajo su madre, en su orden", () => {
    render(<DocPageTree kind="space" ownerId="s1" />);
    const apps = screen.getByText("Apps").closest("li")!;
    expect([...apps.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["Nereus", "Triton"]);
    expect(screen.getByText("Entrega").closest("li")!.parentElement!.closest("li")).toBeNull();
  });

  it("plegar una página esconde lo que cuelga de ella", () => {
    render(<DocPageTree kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Apps" }));
    expect(screen.queryByText("Nereus")).toBeNull();
    expect(screen.getByText("Entrega")).toBeTruthy();
  });

  it("el «+» de una fila crea una hija suya", async () => {
    post.mockResolvedValue({ data: null });
    render(<DocPageTree kind="space" ownerId="s1" />);
    const apps = screen.getByText("Apps").closest("li")!.firstElementChild!;
    fireEvent.click(apps.querySelector('button[aria-label="New page inside"]')!);
    expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages", { title: "Untitled", parentId: "p1" });
  });

  it("el «+» de la portada crea una página de primer nivel", () => {
    post.mockResolvedValue({ data: null });
    render(<DocPageTree kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages", { title: "Untitled" });
  });

  it("la portada cierra la página abierta", () => {
    useDocPages.setState({ activePageId: "p2" });
    render(<DocPageTree kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByText("Home"));
    expect(useDocPages.getState().activePageId).toBeNull();
  });
});

/** Abre el menú de una fila y pulsa una opción. */
const menu = async (title: string, opcion: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Options for “${title}”` }));
  fireEvent.click(await screen.findByText(opcion));
};

describe("el menú de una página", () => {
  it("renombrar pregunta el título y lo guarda", async () => {
    put.mockResolvedValue({ data: { id: "p2", title: "Nereus 2" } });
    render(<DocPageTree kind="space" ownerId="s1" />);
    await menu("Nereus", "Rename");
    const caja = await screen.findByDisplayValue("Nereus");
    fireEvent.change(caja, { target: { value: "Nereus 2" } });
    fireEvent.submit(caja.closest("form")!);
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages/p2", { title: "Nereus 2" }));
  });

  /**
   * «Mover a…»: lo que no puede ser no se ofrece. La propia página y lo que
   * cuelga de ella salen atenuadas; la portada y las demás, sí.
   */
  it("mover a… no deja colgarla de sí misma ni de sus hijas", async () => {
    render(<DocPageTree kind="space" ownerId="s1" />);
    await menu("Apps", "Move to…");
    const dialogo = await screen.findByRole("dialog");
    const opcion = (t: string) => within(dialogo).getByText(t).closest("button")!;
    expect(opcion("Apps").disabled).toBe(true);
    expect(within(dialogo).queryByText("Nereus")).toBeNull();
    expect(opcion("Entrega").disabled).toBe(false);
  });

  it("mover a… la pone al final de la madre elegida", async () => {
    post.mockResolvedValue({ data: [] });
    render(<DocPageTree kind="space" ownerId="s1" />);
    await menu("Entrega", "Move to…");
    const dialogo = await screen.findByRole("dialog");
    fireEvent.click(within(dialogo).getByText("Apps"));
    fireEvent.click(within(dialogo).getByText("Move here"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages/p4/move", { parentId: "p1", afterId: "p3" }),
    );
  });

  it("donde ya está no se puede mover", async () => {
    render(<DocPageTree kind="space" ownerId="s1" />);
    await menu("Nereus", "Move to…");
    const dialogo = await screen.findByRole("dialog");
    fireEvent.click(within(dialogo).getByText("Apps"));
    expect(within(dialogo).getByText("Move here").closest("button")!.disabled).toBe(true);
  });

  it("a la papelera pregunta, y dice cuántas se van con ella", async () => {
    render(<DocPageTree kind="space" ownerId="s1" />);
    await menu("Apps", "Move to trash");
    expect(await screen.findByText(/The 2 pages inside it go with it/)).toBeTruthy();
  });
});

describe("la papelera", () => {
  it("dice cuándo y cuántas, y restaurar trae la página", async () => {
    get.mockImplementation(async (p: string) =>
      p.endsWith("?trashed=1")
        ? { data: [{ ...fila("t1", "Viejo"), deletedAt: "2026-10-08T12:00:00Z", subpages: 3 }] }
        : { data: [] },
    );
    post.mockResolvedValue({ success: true });
    render(<DocPageTree kind="space" ownerId="s1" />);
    fireEvent.click(screen.getByText("Trash"));
    expect(await screen.findByText("Viejo")).toBeTruthy();
    expect(screen.getByText(/3 pages inside/)).toBeTruthy();
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/docs/space/s1/pages/t1/restore", {}));
    await waitFor(() => expect(screen.queryByText("Viejo")).toBeNull());
  });
});
