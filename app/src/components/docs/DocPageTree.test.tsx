import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El árbol del lateral: la portada arriba, las páginas anidadas debajo, y el
 * «+» de cada fila crea **dentro** de esa fila — lo que hace Confluence.
 */

const post = vi.fn();
const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (p: string) => get(p), post: (p: string, b: unknown) => post(p, b), put: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));

const { default: DocPageTree } = await import("@/components/docs/DocPageTree");
const { useDocPages } = await import("@/store/doc-pages.store");

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
    expect(screen.getByText("Entrega").closest("li")!.parentElement!.parentElement!.tagName).toBe("ASIDE");
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
