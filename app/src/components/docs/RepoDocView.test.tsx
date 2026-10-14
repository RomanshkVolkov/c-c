import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Un .md del repo, leído en cac: de sólo lectura y diciéndolo.
 * Mutantes: «Ver en GitHub» a otra URL; pintarlo con el editor (habría un
 * cuadro de texto); no cerrar el fichero al salir (el panel lo seguiría
 * marcando); pintar el cuerpo de uno demasiado grande; no resolver los
 * enlaces contra la ruta (un `../a.md` iría al navegador); pedir las imágenes
 * relativas tal cual (en un repo privado no cargan).
 */

const { get, openExternal } = vi.hoisted(() => ({ get: vi.fn(), openExternal: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<object>()), openExternal }));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));

const { default: RepoDocView } = await import("@/components/docs/RepoDocView");
const { useRepoDocs } = await import("@/store/repo-docs.store");

const GROUP = {
  repoId: 200,
  fullName: "dwit/web",
  branch: "main",
  state: "ok",
  syncedAt: null,
  files: [{ id: "rd-readme", path: "README.md", title: "Web" }],
};

const DOC = {
  id: "rd-1",
  orgId: "org-1",
  repoId: 200,
  path: "docs/deploy.md",
  title: "Desplegar",
  body: "# Desplegar\n\nCon `make deploy`.",
  tooLarge: false,
  fullName: "dwit/web",
  branch: "main",
  spaceId: "sp-1",
  htmlUrl: "https://github.com/dwit/web/blob/main/docs/deploy.md",
  syncedAt: "2026-10-13T10:00:00Z",
};

beforeEach(() => {
  openExternal.mockResolvedValue(undefined);
  useRepoDocs.setState({ bySpace: {}, open: null, pendingRoute: null });
  get.mockReset();
  openExternal.mockClear();
});
afterEach(cleanup);

describe("un .md del repo", () => {
  it("se lee, sin editor, y «Ver en GitHub» lleva a su fichero", async () => {
    get.mockResolvedValue({ success: true, data: DOC });
    render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(screen.getByText("make deploy")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/api/v1/repo-docs/rd-1");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("[contenteditable]")).toBeNull();
    expect(screen.getByText("main")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /View on GitHub/ }));
    expect(openExternal).toHaveBeenCalledWith(DOC.htmlUrl);
  });

  it("al salir, el fichero deja de estar abierto", async () => {
    get.mockResolvedValue({ success: true, data: DOC });
    const { unmount } = render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(useRepoDocs.getState().open?.id).toBe("rd-1"));
    unmount();
    expect(useRepoDocs.getState().open).toBeNull();
  });

  it("uno demasiado grande no se pinta: se manda a GitHub", async () => {
    get.mockResolvedValue({ success: true, data: { ...DOC, tooLarge: true, body: "" } });
    render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(screen.getByText(/too large to show here/)).toBeTruthy());
  });

  it("uno que ya no está lo dice", async () => {
    get.mockRejectedValue(new Error("not-found"));
    render(<RepoDocView id="rd-x" />);
    await waitFor(() => expect(screen.getByText(/no longer in the repository/)).toBeTruthy());
  });
});

describe("los enlaces y las imágenes de un .md del repo", () => {
  it("un .md vecino se abre en cac; lo demás, en GitHub; la imagen se pide a cac", async () => {
    const body = "Ver [la portada](../README.md) y [el código](../src/main.go).\n\n![arq](img/arq.png)";
    get.mockImplementation(async (url: string) =>
      url.startsWith("/api/v1/repo-docs?") ? { success: true, data: [GROUP] } : { success: true, data: { ...DOC, body } },
    );
    render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(useRepoDocs.getState().bySpace["sp-1"]).toBeTruthy());

    fireEvent.click(screen.getByText("la portada"));
    expect(useRepoDocs.getState().pendingRoute).toBe("/docs?repoDoc=rd-readme");

    fireEvent.click(screen.getByText("el código"));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/dwit/web/blob/main/src/main.go");

    const img = screen.getByAltText("arq") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/api/v1/repo-docs/raw/200?path=docs%2Fimg%2Farq.png");
  });
});

describe("quién lo cambió", () => {
  // Si un push lo contó, se dice quién y se va al commit; si no, cuándo se
  // copió. Mutante: enseñar siempre «sincronizado».
  it("lo dice, y lleva a su commit", async () => {
    get.mockResolvedValue({
      success: true,
      data: { ...DOC, lastAuthor: "ana", lastCommitAt: "2026-10-14T10:00:00Z", lastMessage: "arreglar pasos",
        commitUrl: "https://github.com/dwit/web/commit/abc" },
    });
    render(<RepoDocView id="rd-1" />);
    const who = await screen.findByRole("button", { name: /Changed by ana/ });
    expect(who.getAttribute("title")).toBe("arreglar pasos");
    fireEvent.click(who);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/dwit/web/commit/abc");
    expect(screen.queryByText(/^Synced/)).toBeNull();
  });
});
